import type { HomeSection, Site, Vod } from '@shared/types'
import { normalizeSearchTitle } from '@shared/searchMatch'
import { asArray, buildCmsBrowseUrl, buildCmsUrl, isCmsOk } from './cms'
import { fetchText, parseLooseJson } from './http'
import { cmsItemToVod, searchCmsExactTitle } from './search'
import { listCongcongSourceHome, listJianpianHome } from './congcongSources'
import { getSettings } from './settings'
import { getSites, resolveHeader } from './sites'
import { getParsed, listSources } from './sources'

/** 每个内容位最多放多少条。首页是横向滑动的，太多没必要，也省流量 */
const LIMIT = 24
const MAX_EXPAND_PAGES = 100
/** 首页内容位缓存多久。首页是每次启动都看的第一个页面，不缓存等于每次启动都打一遍所有源 */
const TTL = 10 * 60 * 1000
/**
 * 失败的那几条只缓存 1 分钟。
 *
 * 「fetch failed」很多时候是一次网络的抖动（实测素博第一次拉就失败、紧接着重试就好了），
 * 按 10 分钟缓存下来会让用户盯着一条错误的横条看很久。
 */
const ERROR_TTL = 60 * 1000
const XIGUA_CHILDREN: Record<string, string[]> = {
  movie: ['6', '7', '8', '9', '10', '11', '12', '20', '34', '37'],
  series: ['13', '14', '15', '16', '21', '22', '23', '24'],
  variety: ['25', '26', '27', '28'],
  anime: ['29', '30', '31', '32', '33']
}
const XIGUA_CHILD_TIMEOUT = 7
const XIGUA_PAGE_SIZE = 20
const GUAZI_REPLACEMENT_SOURCES = new Set(['dyttzy', 'ffzy', 'lzi', 'bfzy'])
const HOME_MATCH_CONCURRENCY = 12
const HOME_MATCH_CACHE_TTL = 10 * 60 * 1000
const HOME_MATCH_MISS_TTL = 2 * 60 * 1000
const HOME_MATCH_CACHE_LIMIT = 600

interface HomeMatchCacheEntry {
  createdAt: number
  value: Vod | null
}

const homeMatchCache = new Map<string, HomeMatchCacheEntry>()
const homeMatchInFlight = new Map<string, Promise<Vod | undefined>>()
const homeMatchWaiters: Array<() => void> = []
let activeHomeMatches = 0

interface Plan {
  key: string
  title: string
  origin: 'config' | 'default'
  site: Site
  typeId?: string
  categoryId?: string
  childTypeIds?: string[]
  pid?: string
  query?: string
}

async function withHomeMatchSlot<T>(work: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    const start = (): void => {
      activeHomeMatches++
      resolve()
    }
    if (activeHomeMatches < HOME_MATCH_CONCURRENCY) start()
    else homeMatchWaiters.push(start)
  })

  try {
    return await work()
  } finally {
    activeHomeMatches--
    homeMatchWaiters.shift()?.()
  }
}

async function findReplacementItem(site: Site, item: Vod, timeoutSeconds: number): Promise<Vod | undefined> {
  const title = normalizeSearchTitle(item.vod_name)
  if (!title) return undefined
  const key = `${site.key}|${site.sourceId}|${site.api}|${title}`
  const cached = homeMatchCache.get(key)
  if (cached) {
    const ttl = cached.value ? HOME_MATCH_CACHE_TTL : HOME_MATCH_MISS_TTL
    if (Date.now() - cached.createdAt < ttl) {
      homeMatchCache.delete(key)
      homeMatchCache.set(key, cached)
      return cached.value ? { ...cached.value } : undefined
    }
    homeMatchCache.delete(key)
  }

  const inFlight = homeMatchInFlight.get(key)
  if (inFlight) return inFlight.then((match) => match ? { ...match } : undefined)

  const request = withHomeMatchSlot(() => searchCmsExactTitle(site, item.vod_name, timeoutSeconds))
    .then((result) => {
      const match = result && normalizeSearchTitle(result.vod_name) === title ? result : undefined
      homeMatchCache.set(key, { createdAt: Date.now(), value: match ?? null })
      while (homeMatchCache.size > HOME_MATCH_CACHE_LIMIT) {
        const oldest = homeMatchCache.keys().next().value
        if (!oldest) break
        homeMatchCache.delete(oldest)
      }
      return match ? { ...match } : undefined
    })
    .catch(() => undefined)
    .finally(() => homeMatchInFlight.delete(key))
  homeMatchInFlight.set(key, request)
  return request.then((match) => match ? { ...match } : undefined)
}

async function replaceGuaziItems(
  site: Site,
  items: Vod[],
  timeoutSeconds: number
): Promise<Vod[]> {
  const replacements = await Promise.all(items.map((item) => findReplacementItem(site, item, timeoutSeconds)))
  return replacements.filter((item): item is Vod => Boolean(item))
}

function fallbackHomeKeys(homeSourceKey: string): string[] {
  if (homeSourceKey === 'guazi' || GUAZI_REPLACEMENT_SOURCES.has(homeSourceKey)) {
    return ['xgzy', 'dyttzy', 'ffzy', 'lzi', 'bfzy']
  }
  if (homeSourceKey === 'xgzy') return ['jianpian']
  return ['guazi', 'xgzy']
}

/**
 * 从配置源的 `home.sections` 里读内容位。
 *
 * `site` 这一项各家配置写得不一样：有的写站点 key，有的写中文名。
 * 所以按「key 精确 → 名字精确 → 名字互相包含」三级去找，都找不到就跳过。
 */
function matchSite(sites: Site[], ref: string): Site | undefined {
  const want = ref.trim()
  if (!want) return undefined
  const lower = want.toLowerCase()
  return (
    sites.find((s) => s.key === want) ??
    sites.find((s) => s.name === want) ??
    sites.find((s) => s.key.toLowerCase() === lower || s.name.toLowerCase() === lower) ??
    sites.find((s) => s.name.includes(want) || want.includes(s.name))
  )
}

/** 首页当前支持苹果CMS和瓜子专用推荐片单。 */
function isHomeSource(site: Site): boolean {
  if (!site.homeEnabled || !site.enabled || site.unsupported || !site.api) return false
  if (site.key === 'guazi' || site.key === 'jianpian') return true
  return site.key !== 'jianpian'
    && (site.type === 3 || site.type === 4)
}

async function defaultPlansFor(key: string, sites: Site[]): Promise<Plan[]> {
  const site = sites.find((candidate) => candidate.key === key && isHomeSource(candidate))
  if (!site) return []
  if (key === 'jianpian') {
    return [
      { key: 'jianpian::series', title: '荐片 · 热门电视剧', origin: 'default', site, query: '热播', categoryId: '2' },
      { key: 'jianpian::movie', title: '荐片 · 热门电影', origin: 'default', site, query: '热播', categoryId: '1' },
      { key: 'jianpian::variety', title: '荐片 · 热门综艺', origin: 'default', site, query: '热播', categoryId: '4' },
      { key: 'jianpian::anime', title: '荐片 · 热门动漫', origin: 'default', site, query: '热播', categoryId: '3' }
    ]
  }
  if (key === 'xgzy') {
    try {
      const url = buildCmsUrl(site, { ac: 'list' })
      const payload = parseLooseJson(await fetchText(url, { header: await resolveHeader(site, url) }))
      if (isCmsOk(payload)) {
        const body = payload as Record<string, unknown>
        const classes = asArray<Record<string, unknown>>(body.class)
        const roots = classes.filter((item) => {
          const parent = String(item.type_pid ?? item.pid ?? '0').trim()
          return !parent || parent === '0'
        })
        const categories = roots.length ? roots : classes
        const wanted: Array<{ key: keyof typeof XIGUA_CHILDREN; title: string; pattern: RegExp }> = [
          { key: 'movie', title: '热门电影', pattern: /电影/ },
          { key: 'series', title: '热门电视剧', pattern: /电视剧|连续剧|剧集/ },
          { key: 'variety', title: '热门综艺', pattern: /综艺/ },
          { key: 'anime', title: '热门动漫', pattern: /动漫|动画/ }
        ]
        const plans = wanted.flatMap((category) => {
          const item = categories.find((candidate) => category.pattern.test(String(candidate.type_name ?? candidate.name ?? '')))
          const typeId = String(item?.type_id ?? item?.id ?? '').trim()
          return typeId
            ? [{
                key: `xgzy::${category.key}`,
                title: `西瓜 · ${category.title}`,
                origin: 'default' as const,
                site,
                typeId,
                childTypeIds: XIGUA_CHILDREN[category.key]
              }]
            : []
        })
        if (plans.length) return plans
      }
    } catch {
      // 分类表短暂不可用时，保留常见 CMS 分类入口并由内容请求显示源错误。
    }
    return [
      { key: 'xgzy::movie', title: '西瓜 · 热门电影', origin: 'default', site, typeId: '1', childTypeIds: XIGUA_CHILDREN.movie },
      { key: 'xgzy::series', title: '西瓜 · 热门电视剧', origin: 'default', site, typeId: '2', childTypeIds: XIGUA_CHILDREN.series },
      { key: 'xgzy::variety', title: '西瓜 · 热门综艺', origin: 'default', site, typeId: '3', childTypeIds: XIGUA_CHILDREN.variety },
      { key: 'xgzy::anime', title: '西瓜 · 热门动漫', origin: 'default', site, typeId: '4', childTypeIds: XIGUA_CHILDREN.anime }
    ]
  }
  return [{ key: `${key}::latest`, title: `${site.name} · 最近更新`, origin: 'default', site }]
}

async function buildPlan(): Promise<{
  plans: Plan[]
  missing: HomeSection[]
  sites: Site[]
  homeSourceKey: string
  replacementSourceKey?: string
  replacementSite?: Site
  matchTimeout: number
}> {
  const sites = (await getSites()).filter((s) => s.enabled)
  const sources = await listSources()
  const settings = await getSettings()
  const homeSourceKey = settings.homeSourceKey || 'guazi'
  const replacementSourceKey = GUAZI_REPLACEMENT_SOURCES.has(homeSourceKey) ? homeSourceKey : undefined
  const replacementSite = replacementSourceKey
    ? sites.find((site) => site.key === replacementSourceKey && isHomeSource(site))
    : undefined
  const plans: Plan[] = []
  const missing: HomeSection[] = []
  const seen = new Set<string>()

  for (const source of sources) {
    if (!source.enabled) continue
    const sections = getParsed(source.id)?.home?.sections ?? []
    for (const raw of sections) {
      const title = String(raw?.title ?? '').trim()
      const ref = String(raw?.site ?? '').trim()
      if (!title && !ref) continue
      const site = matchSite(sites, ref)
      if (!site) {
        missing.push({
          key: `missing:${source.id}:${ref}`,
          title: title || ref,
          origin: 'config',
          items: [],
          error: `配置里写的影视源「${ref}」不在当前已启用的源里`
        })
        continue
      }
      if (!isHomeSource(site)) {
        missing.push({
          key: `unsupported:${source.id}:${site.key}`,
          title: title || site.name,
          origin: 'config',
          siteKey: site.key,
          siteName: site.name,
          items: [],
          error: `${site.name} 暂不支持首页推荐内容`
        })
        continue
      }
      const typeId = raw?.typeId === undefined || raw?.typeId === '' ? undefined : String(raw.typeId)
      const pid = raw?.pid === undefined || raw?.pid === '' ? undefined : String(raw.pid)
      const key = `${site.key}::${pid ?? ''}::${typeId ?? 'latest'}`
      if (seen.has(key)) continue
      seen.add(key)
      plans.push({
        key,
        title: title || (typeId ? `${site.name} · ${typeId}` : `${site.name} · 最近更新`),
        origin: 'config',
        site,
        typeId,
        childTypeIds: site.key === 'xgzy' ? XIGUA_CHILDREN[typeId ?? ''] : undefined,
        pid
      })
    }
  }

  // 未配置首页内容位时，仍让首选首页源有可展示的内容。
  if (!plans.length) {
    for (const site of sites) {
      if (!isHomeSource(site)) continue
      plans.push({
        key: `${site.key}::latest`,
        title: `${site.name} · 最近更新`,
        origin: 'default',
        site
      })
    }
  }

  const primarySourceKey = replacementSourceKey ? 'guazi' : homeSourceKey
  const selectedPlans = plans.filter((plan) => plan.site.key === primarySourceKey)
  let preferredPlans = selectedPlans.length ? selectedPlans : await defaultPlansFor(primarySourceKey, sites)
  if (!preferredPlans.length && !replacementSourceKey) {
    for (const key of fallbackHomeKeys(homeSourceKey)) {
      preferredPlans = await defaultPlansFor(key, sites)
      if (preferredPlans.length) break
    }
  }
  return {
    plans: replacementSourceKey ? preferredPlans : preferredPlans.length ? preferredPlans : plans,
    missing,
    sites,
    homeSourceKey,
    replacementSourceKey,
    replacementSite,
    matchTimeout: settings.singleSourceTimeoutSeconds
  }
}

async function loadSection(
  plan: Plan,
  replacementSourceKey?: string,
  replacementSite?: Site,
  matchTimeout = 2
): Promise<HomeSection> {
  const base = {
    key: plan.key,
    title: plan.title,
    origin: plan.origin,
    siteKey: plan.site.key,
    siteName: plan.site.name
  }
  try {
    if (plan.site.key === 'guazi') {
      if (replacementSourceKey && !replacementSite) {
        return { ...base, items: [], error: `首页替换源「${replacementSourceKey}」未启用` }
      }
      const items = await listCongcongSourceHome(plan.site, plan.typeId, LIMIT, plan.pid)
      if (!items.length) return { ...base, items: [], error: '瓜子首页加载失败：片单没有返回数据' }
      if (!replacementSite) return { ...base, items }
      const matched = await replaceGuaziItems(replacementSite, items, matchTimeout)
      if (!matched.length) return { ...base, items: [], error: `「${replacementSite.name}」没有找到瓜子片单中的同名影片` }
      return { ...base, items: matched }
    }
    if (plan.site.key === 'jianpian') {
      const items = await listJianpianHome(plan.site, LIMIT, plan.query, plan.categoryId)
      if (!items.length) return { ...base, items: [], error: '荐片首页没有返回数据' }
      return { ...base, items, total: items.length, hasMore: items.length >= LIMIT }
    }

    const page = await loadCmsHomePage(plan, 1)
    const items = page.items.slice(0, LIMIT)
    if (!items.length) return { ...base, items: [], error: '这一个内容位没有返回数据' }
    return {
      ...base,
      items,
      total: page.total,
      pageCount: page.pageCount,
      hasMore: page.pageCount ? page.pageCount > 1 : page.items.length > 0
    }
  } catch (err) {
    const error = (err as Error).message
    return { ...base, items: [], error: plan.site.key === 'guazi' ? `瓜子首页加载失败：${error}` : error }
  }
}

interface CmsHomePage {
  items: HomeSection['items']
  total?: number
  pageCount?: number
}

async function loadCmsHomePage(plan: Plan, page: number): Promise<CmsHomePage> {
  if (plan.site.key === 'xgzy' && plan.childTypeIds?.length) {
    return loadXiguaHomePage(plan, page)
  }
  // ac=detail 会把 vod_play_url 一起带回来，点进详情就不用再请求一次
  let url = plan.typeId
    ? buildCmsBrowseUrl(plan.site, 'detail', [plan.typeId], page)
    : buildCmsUrl(plan.site, { ac: 'detail', pg: page })
  if (page > 1 && !/\{(?:pg|page)\}/i.test(plan.site.api) && !/[?&](?:pg|page)=/i.test(url)) {
    const separator = url.includes('?') ? (url.endsWith('?') || url.endsWith('&') ? '' : '&') : '?'
    url = `${url}${separator}pg=${page}`
  }
  const text = await fetchText(url, { header: await resolveHeader(plan.site, url) })
  const payload = parseLooseJson(text)
  if (!isCmsOk(payload)) {
    const msg = String((payload as Record<string, unknown>)?.msg ?? '') || 'code 非成功'
    throw new Error(`接口返回异常：${msg}`)
  }
  const body = payload as Record<string, unknown>
  const total = Number(body.total)
  const pageCount = Number(body.pagecount)
  return {
    items: asArray<Record<string, unknown>>(body.list).map((item) => cmsItemToVod(item, plan.site)),
    ...(Number.isFinite(total) && total > 0 ? { total } : {}),
    ...(Number.isFinite(pageCount) && pageCount > 0 ? { pageCount } : {})
  }
}

async function loadXiguaHomePage(plan: Plan, page: number): Promise<CmsHomePage> {
  const responses = await Promise.allSettled(plan.childTypeIds!.map(async (typeId) => {
    const url = buildCmsBrowseUrl(plan.site, 'list', [typeId], page)
    const text = await fetchText(url, {
      header: await resolveHeader(plan.site, url),
      timeout: XIGUA_CHILD_TIMEOUT
    })
    const payload = parseLooseJson<Record<string, unknown>>(text)
    if (!isCmsOk(payload)) throw new Error(`子分类 ${typeId} 返回异常`)
    return payload
  }))
  const successful = responses.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  if (!successful.length) throw new Error('西瓜首页子分类暂时都无法加载')

  const rows: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let total = 0
  let maxPageCount = 0
  for (const payload of successful) {
    const body = payload as Record<string, unknown>
    const childTotal = Number(body.total)
    const childPageCount = Number(body.pagecount)
    if (Number.isFinite(childTotal) && childTotal > 0) total += childTotal
    if (Number.isFinite(childPageCount) && childPageCount > 0) maxPageCount = Math.max(maxPageCount, childPageCount)
    for (const item of asArray<Record<string, unknown>>(body.list)) {
      const id = String(item.vod_id ?? item.id ?? '').trim()
      const name = String(item.vod_name ?? item.name ?? '').trim()
      const identity = id || `${name}|${String(item.vod_pic ?? item.pic ?? '')}`
      if (!name || !identity || seen.has(identity)) continue
      seen.add(identity)
      if (rows.length < XIGUA_PAGE_SIZE) rows.push(item)
    }
  }

  const items = rows.map((item) => cmsItemToVod(item, plan.site))
  const missingPictures = items.filter((item) => item.vod_id && !item.vod_pic)
  if (missingPictures.length) {
    try {
      const ids = missingPictures.map((item) => item.vod_id).join(',')
      const url = buildCmsUrl(plan.site, { ac: 'detail', ids })
      const text = await fetchText(url, { header: await resolveHeader(plan.site, url), timeout: XIGUA_CHILD_TIMEOUT })
      const payload = parseLooseJson<Record<string, unknown>>(text)
      if (isCmsOk(payload)) {
        const pictures = new Map(asArray<Record<string, unknown>>(payload.list).map((item) => {
          const vod = cmsItemToVod(item, plan.site)
          return [vod.vod_id, vod.vod_pic] as const
        }))
        for (const item of items) item.vod_pic ||= pictures.get(item.vod_id) ?? ''
      }
    } catch {
      // 缺图补齐失败时仍显示已成功获取的分类结果。
    }
  }

  return {
    items,
    ...(total > 0 ? { total } : {}),
    ...(maxPageCount > 0 || total > 0
      ? { pageCount: Math.max(maxPageCount, Math.ceil(total / XIGUA_PAGE_SIZE)) }
      : {})
  }
}

/** 展开时才逐页读取 AppleCMS 内容位，避免首屏请求随片单总量增长。 */
export async function expandHomeSection(key: string): Promise<HomeSection> {
  const { plans, sites, replacementSourceKey, replacementSite, matchTimeout } = await buildPlan()
  let plan = plans.find((candidate) => candidate.key === key)
  if (!plan && key === 'xgzy::latest') {
    const site = sites.find((candidate) => candidate.key === 'xgzy' && isHomeSource(candidate))
    if (site) plan = { key, title: '西瓜 · 最近更新', origin: 'default', site }
  }
  if (!plan) throw new Error('首页片单已变更，请刷新首页后重试')
  if (plan.site.key === 'jianpian') {
    const items = await listJianpianHome(plan.site, 100, plan.query, plan.categoryId)
    return {
      key: plan.key,
      title: plan.title,
      origin: plan.origin,
      siteKey: plan.site.key,
      siteName: plan.site.name,
      items,
      total: items.length,
      pageCount: 1,
      hasMore: false
    }
  }
  if (plan.site.key === 'guazi') {
    const items = await listCongcongSourceHome(plan.site, plan.typeId, Number.POSITIVE_INFINITY, plan.pid)
    const displayedItems = replacementSourceKey
      ? replacementSite
        ? await replaceGuaziItems(replacementSite, items, matchTimeout)
        : []
      : items
    if (replacementSourceKey && !replacementSite) throw new Error(`首页替换源「${replacementSourceKey}」未启用`)
    return {
      key: plan.key,
      title: plan.title,
      origin: plan.origin,
      siteKey: plan.site.key,
      siteName: plan.site.name,
      items: displayedItems,
      total: displayedItems.length,
      pageCount: 1,
      hasMore: false
    }
  }

  const first = await loadCmsHomePage(plan, 1)
  const items = [...first.items]
  const seen = new Set(items.map((item) => item.vod_id || `${item.vod_name}|${item.vod_pic}`))
  let page = 2
  let lastPageLoaded = 1

  while (page <= MAX_EXPAND_PAGES) {
    const result = await loadCmsHomePage(plan, page)
    lastPageLoaded = page
    let added = 0
    for (const item of result.items) {
      const identity = item.vod_id || `${item.vod_name}|${item.vod_pic}`
      if (seen.has(identity)) continue
      seen.add(identity)
      items.push(item)
      added++
    }

    // Probe past reported pagecount so stale or missing metadata cannot truncate the list.
    if (added === 0) break
    page++
  }

  return {
    key: plan.key,
    title: plan.title,
    origin: plan.origin,
    siteKey: plan.site.key,
    siteName: plan.site.name,
    items,
    total: first.total ?? items.length,
    pageCount: lastPageLoaded,
    hasMore: page > MAX_EXPAND_PAGES
  }
}

let cache: { sig: string; at: number; sections: HomeSection[] } | null = null

/**
 * 首页内容位。配置里有 `home.sections` 就按配置来，没有就每个可用源给一条「最近更新」。
 *
 * 拉取是**失败不抛**的：某个源挂了只让那一条内容位自己显示错误，
 * 不能让整个首页白屏。
 */
export async function listHomeSections(force = false): Promise<HomeSection[]> {
  const { plans, missing, sites, homeSourceKey, replacementSourceKey, replacementSite, matchTimeout } = await buildPlan()
  const sig = `${homeSourceKey}|${replacementSite?.api ?? 'replacement-unavailable'}|${plans.map((p) => `${p.key}:${p.pid ?? ''}:${p.query ?? ''}`).join('|')}`

  if (!force && cache && cache.sig === sig) {
    const age = Date.now() - cache.at
    // 上一次有拉失败的内容位时只用短 TTL，让抖动过的源很快有机会翻身
    const limit = cache.sections.some((s) => s.error) ? ERROR_TTL : TTL
    if (age < limit) return [...cache.sections, ...missing]
  }

  const settings = await getSettings()
  const concurrency = Math.max(1, Math.min(32, settings.concurrency ?? 10))
  const sections: HomeSection[] = new Array(plans.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= plans.length) return
      sections[index] = await loadSection(plans[index], replacementSourceKey, replacementSite, matchTimeout)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, () => worker()))

  let filled = sections.filter(Boolean)
  const guaziFailed = plans.length === 0 || filled.some((section) =>
    section.siteKey === 'guazi' && section.error?.startsWith('瓜子首页加载失败：')
  )
  const hasItems = filled.some((section) => section.items.length)
  const shouldFallback = replacementSourceKey
    ? !hasItems && guaziFailed
    : homeSourceKey === 'guazi'
      ? !hasItems && guaziFailed
      : !hasItems
  if (shouldFallback) {
    const fallbackKeys = fallbackHomeKeys(homeSourceKey)
    for (const key of fallbackKeys) {
      const fallbackPlans = await defaultPlansFor(key, sites)
      if (!fallbackPlans.length) continue
      const fallback = await Promise.all(fallbackPlans.map((plan) => loadSection(plan)))
      const successful = fallback.filter((section) => section.items.length)
      if (successful.length) {
        filled = successful
        break
      }
    }
  }
  cache = { sig, at: Date.now(), sections: filled }
  return [...filled, ...missing]
}

/** 站点列表变了（换源、启用开关）就得让缓存失效 */
export function clearHomeCache(): void {
  cache = null
}
