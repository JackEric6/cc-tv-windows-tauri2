import * as cheerio from 'cheerio'
import type { SearchOptions, SearchResponse, Site, SiteSearchResult, Vod } from '@shared/types'
import { normalizeSearchTitle } from '@shared/searchMatch'
import { asArray, buildCmsUrl, cmsApiCandidates, cmsRefererForApi, isCmsOk } from './cms'
import { fetchText, parseLooseJson } from './http'
import { absolutizeCmsImage, extract } from './htmlRules'
import { getSettings } from './settings'
import { getSites, resolveHeader } from './sites'
import { searchCongcongSource } from './congcongSources'
import { isNativeAdaptedSite, searchNativeSite } from './nativeSites'

const DEFAULT_LIMIT = 30
const SEARCH_CACHE_TTL_MS = 60_000
const SEARCH_CACHE_LIMIT = 120

interface SearchCacheEntry {
  createdAt: number
  result: SiteSearchResult
}

const searchCache = new Map<string, SearchCacheEntry>()
const searchInFlight = new Map<string, Promise<SiteSearchResult>>()

/** 搜索请求的取消令牌：发起新搜索时旧的那一批会自行停下 */
let currentToken = 0
const activeSearchControllers = new Set<AbortController>()

export function cancelSearch(): void {
  currentToken++
  for (const controller of activeSearchControllers) controller.abort()
  activeSearchControllers.clear()
}

function searchCacheKey(site: Site, keyword: string, limit: number, timeout: number): string {
  return JSON.stringify([keyword, limit, timeout, site])
}

function copySearchResult(result: SiteSearchResult, cached = false): SiteSearchResult {
  return {
    ...result,
    ms: cached ? 0 : result.ms,
    list: result.list.map((vod) => ({ ...vod }))
  }
}

function readSearchCache(key: string): SiteSearchResult | undefined {
  const entry = searchCache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.createdAt >= SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key)
    return undefined
  }
  searchCache.delete(key)
  searchCache.set(key, entry)
  return copySearchResult(entry.result, true)
}

function writeSearchCache(key: string, result: SiteSearchResult): void {
  if (!result.ok) return
  searchCache.delete(key)
  searchCache.set(key, { createdAt: Date.now(), result: copySearchResult(result) })
  while (searchCache.size > SEARCH_CACHE_LIMIT) {
    const oldest = searchCache.keys().next().value
    if (!oldest) break
    searchCache.delete(oldest)
  }
}

function searchSiteCached(
  site: Site,
  keyword: string,
  limit: number,
  timeout: number,
  signal: AbortSignal,
  requestToken: number
): Promise<SiteSearchResult> {
  const key = searchCacheKey(site, keyword, limit, timeout)
  const cached = readSearchCache(key)
  if (cached) return Promise.resolve(cached)

  const inFlightKey = `${key}:${requestToken}`
  const existing = searchInFlight.get(inFlightKey)
  if (existing) return existing.then((result) => copySearchResult(result))

  const request = searchSite(site, keyword, limit, timeout, signal)
    .then((result) => {
      writeSearchCache(key, result)
      return result
    })
    .finally(() => {
      searchInFlight.delete(inFlightKey)
    })
  searchInFlight.set(inFlightKey, request)
  return request.then((result) => copySearchResult(result))
}

function withSiteSearchDeadline(
  site: Site,
  promise: Promise<SiteSearchResult>,
  controller: AbortController,
  timeoutSeconds: number
): Promise<SiteSearchResult> {
  const deadlineMs = timeoutSeconds * 1000
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<SiteSearchResult>((resolve) => {
    timer = setTimeout(() => {
      resolve(fail(site, `搜索超过 ${timeoutSeconds} 秒，已跳过该站点`, deadlineMs))
      controller.abort()
    }, deadlineMs)
  })
  return Promise.race([promise, timedOut]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 使用安卓端同款爱奇艺联想接口；失败由调用方回退到本地片名单。 */
export async function suggestSearchKeywords(keyword: string): Promise<string[]> {
  const query = keyword.trim()
  if (!query) return []
  const url = `https://suggest.video.iqiyi.com/?if=mobile&key=${encodeURIComponent(query)}`
  const text = await fetchText(url, {
    timeout: 5,
    header: {
      Accept: 'application/json,text/plain,*/*',
      Referer: 'https://www.iqiyi.com/'
    }
  })
  const payload = parseLooseJson<Record<string, unknown>>(text)
  const items = Array.isArray(payload.data) ? payload.data : []
  return [...new Set(items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const title = String(record.name ?? record.title ?? '').trim()
    return title ? [title] : []
  }))].slice(0, 20)
}

function fail(site: Site, message: string, ms = 0): SiteSearchResult {
  return { siteKey: site.key, siteName: site.name, ok: false, ms, message, list: [] }
}

/** 把苹果CMS 返回的一条记录归一化成 Vod */
export function cmsItemToVod(raw: Record<string, unknown>, site: Site): Vod {
  const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim())
  return {
    vod_id: s(raw.vod_id ?? raw.id),
    vod_name: s(raw.vod_name ?? raw.name),
    vod_pic: absolutizeCmsImage(s(raw.vod_pic ?? raw.pic), site.api),
    vod_remarks: s(raw.vod_remarks ?? raw.remarks),
    vod_year: s(raw.vod_year ?? raw.year),
    vod_area: s(raw.vod_area ?? raw.area),
    vod_actor: s(raw.vod_actor ?? raw.actor),
    vod_director: s(raw.vod_director ?? raw.director),
    type_name: s(raw.type_name ?? raw.type ?? raw.vod_class ?? raw.vod_type_name ?? raw.class ?? raw.vod_tag ?? raw.tags),
    vod_score: s(raw.vod_score ?? raw.score),
    siteKey: site.key,
    siteName: site.name,
    sourceId: site.sourceId
  }
}

async function searchCms(
  site: Site,
  wd: string,
  limit: number,
  timeout: number,
  signal?: AbortSignal,
  primaryOnly = false
): Promise<Vod[]> {
  let lastError: Error | undefined
  let emptyResult: Vod[] = []
  for (const candidate of primaryOnly ? [site] : cmsApiCandidates(site)) {
    try {
      // 搜索用 ac=detail：MacCMS V10 的 detail 同时支持 wd 关键词，且一次就带回
      // vod_play_url，省掉一次详情请求。只有配置作者在模板里写了 {ac} 时，才按
      // TVBox 惯例填 videolist（部分老版本 CMS 只认这个写法）。
      const ac = /\{ac\}/i.test(candidate.api) ? 'videolist' : 'detail'
      const url = buildCmsUrl(candidate, { ac, wd, pg: 1 })
      const header = await resolveHeader(site, url)
      if (!header.Referer) {
        const referer = cmsRefererForApi(candidate.api)
        if (referer) header.Referer = referer
      }
      const text = await fetchText(url, { header, timeout, signal })
      const payload = parseLooseJson<Record<string, unknown>>(text)
      if (!isCmsOk(payload)) throw new Error(`接口返回异常：${String(payload?.msg ?? 'code 非成功')}`)
      const list = asArray<Record<string, unknown>>(payload.list)
        .slice(0, limit)
        .map((item) => cmsItemToVod(item, site))
        .filter((vod) => vod.vod_name && vod.vod_id)
      if (list.length) return list
      emptyResult = list
      lastError = new Error(`接口 ${new URL(candidate.api).hostname} 没有搜索结果`)
    } catch (error) {
      lastError = error as Error
    }
  }
  if (lastError && emptyResult.length) throw lastError
  if (lastError && !lastError.message.includes('没有搜索结果')) throw lastError
  return emptyResult
}

/** 首页按瓜子片名在指定 CMS 源中找同名条目，不受聚合搜索开关影响。 */
export async function searchCmsExactTitle(
  site: Site,
  title: string,
  timeoutSeconds: number,
  parentSignal?: AbortSignal
): Promise<Vod | undefined> {
  const wanted = normalizeSearchTitle(title)
  if (!wanted) return undefined

  const controller = new AbortController()
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal
  const timeout = Math.max(1, timeoutSeconds) * 1000
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const results = await searchCms(site, title, 100, Math.max(1, timeoutSeconds), signal, true)
    return results.find((item) => normalizeSearchTitle(item.vod_name) === wanted)
  } finally {
    clearTimeout(timer)
  }
}

async function searchHtml(site: Site, wd: string, limit: number, timeout: number, signal?: AbortSignal): Promise<Vod[]> {
  const template = (site.rules?.search || site.api).trim()
  const target = template.replace(/\{(wd|kw|key|keyword)\}/gi, encodeURIComponent(wd))
  if (!/^https?:\/\//i.test(target)) {
    throw new Error('网页规则站缺少可请求的搜索地址')
  }
  const header = await resolveHeader(site, target)
  const text = await fetchText(target, { header, timeout, signal })
  const $ = cheerio.load(text)
  const rules = site.rules ?? {}
  const nodes = $((rules.list || '').trim())
  if (!nodes.length) throw new Error('列表选择器没有匹配到节点，规则可能已失效')

  const out: Vod[] = []
  nodes.slice(0, limit).each((_i, el) => {
    const node = $(el)
    const link = extract($, node, rules.link, target, ['href', 'Text'])
    const name = extract($, node, rules.name, target, ['Text'])
    if (!name) return
    out.push({
      // 网页规则站没有稳定的数字 id，直接把详情页地址当作 id。
      // 这样详情页不需要再猜一次地址，也不会因为站点改版而失效。
      vod_id: link || name,
      vod_name: name,
      vod_pic: extract($, node, rules.pic, target, ['data-src', 'data-original', 'src']),
      vod_remarks: extract($, node, rules.remarks, target, ['Text']),
      vod_year: '',
      vod_area: '',
      vod_actor: '',
      vod_director: '',
      type_name: '',
      vod_score: '',
      siteKey: site.key,
      siteName: site.name,
      sourceId: site.sourceId
    })
  })
  return out
}

/** 搜索单个站点；任何异常都收敛成一个 ok:false 的结果，不影响其它站点 */
export async function searchSite(
  site: Site,
  wd: string,
  limit = DEFAULT_LIMIT,
  timeoutOverride?: number,
  signal?: AbortSignal
): Promise<SiteSearchResult> {
  const start = Date.now()
  if (site.unsupported) return fail(site, site.unsupported)
  if (!site.searchable || !site.searchEnabled) return fail(site, '该站点已关闭搜索')
  if (!site.api) return fail(site, '站点未配置接口地址')

  try {
    const timeout = timeoutOverride ?? site.timeout ?? (await getSettings()).timeout
    let list: Vod[]
    if (site.nativeAdapter === 'guazi' || site.nativeAdapter === 'jianpian' || site.key === 'guazi' || site.key === 'jianpian') {
      list = await searchCongcongSource(site, wd, limit, timeout * 1000, signal)
    } else if (isNativeAdaptedSite(site)) {
      list = await searchNativeSite(site, wd, limit, timeout * 1000, signal)
    } else if (site.type === 3 || site.type === 4) {
      list = await searchCms(site, wd, limit, timeout, signal)
    } else if (site.type === 1) {
      list = await searchHtml(site, wd, limit, timeout, signal)
    } else {
      return fail(site, site.unsupported ?? '该类型暂不支持搜索')
    }
    const ms = Date.now() - start
    return {
      siteKey: site.key,
      siteName: site.name,
      ok: true,
      ms,
      message: list.length ? `找到 ${list.length} 条` : '没有匹配结果',
      list
    }
  } catch (err) {
    return fail(site, (err as Error).message, Date.now() - start)
  }
}

/** 列出当前可以参与聚合搜索的站点 */
export async function searchableSites(): Promise<Site[]> {
  const sites = await getSites()
  return sites
    .filter((s) => s.enabled && s.searchEnabled && s.searchable && !s.unsupported)
    .sort((a, b) => Number(a.key === 'jianpian') - Number(b.key === 'jianpian'))
}

/**
 * 聚合搜索：按并发数把所有启用站点跑一遍。
 * 每完成一个站点就通过 onResult 回报一次，界面可以边搜边出结果。
 */
export async function searchAll(
  wd: string,
  options: SearchOptions = {},
  onResult?: (result: SiteSearchResult, done: number, total: number) => void,
  onStart?: (total: number) => void
): Promise<SearchResponse> {
  const keyword = (wd ?? '').trim()
  const started = Date.now()
  if (!keyword) return { wd: keyword, ms: 0, total: 0, results: [] }

  const token = ++currentToken
  const all = await searchableSites()
  if (token !== currentToken) return { wd: keyword, ms: Date.now() - started, total: 0, results: [] }
  const targets = options.sites?.length
    ? all.filter((s) => options.sites?.includes(s.key))
    : all
  if (!targets.length) return { wd: keyword, ms: 0, total: 0, results: [] }

  const settings = await getSettings()
  if (token !== currentToken) return { wd: keyword, ms: Date.now() - started, total: 0, results: [] }
  onStart?.(targets.length)
  const concurrency = Math.max(
    1,
    Math.min(32, options.concurrency ?? settings.concurrency ?? 10)
  )
  const limit = options.limitPerSite ?? DEFAULT_LIMIT

  const results: Array<SiteSearchResult | undefined> = Array(targets.length)
  const pendingIndexes: number[] = []
  let done = 0
  const timeout = settings.singleSourceTimeoutSeconds
  for (let index = 0; index < targets.length; index++) {
    const site = targets[index]
    const cached = readSearchCache(searchCacheKey(site, keyword, limit, timeout))
    if (!cached) {
      pendingIndexes.push(index)
      continue
    }
    results[index] = cached
    done++
    onResult?.(cached, done, targets.length)
  }

  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      if (token !== currentToken) return
      const pendingIndex = cursor++
      if (pendingIndex >= pendingIndexes.length) return
      const index = pendingIndexes[pendingIndex]
      const site = targets[index]
      const controller = new AbortController()
      activeSearchControllers.add(controller)
      let result: SiteSearchResult
      try {
        result = await withSiteSearchDeadline(
          site,
          searchSiteCached(site, keyword, limit, timeout, controller.signal, token),
          controller,
          timeout
        )
      } finally {
        activeSearchControllers.delete(controller)
      }
      if (token !== currentToken) return
      results[index] = result
      done++
      onResult?.(result, done, targets.length)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pendingIndexes.length) }, () => worker())
  )

  return {
    wd: keyword,
    ms: Date.now() - started,
    total: targets.length,
    results: results.filter((result): result is SiteSearchResult => Boolean(result))
  }
}
