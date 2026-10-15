import type { Site } from '@shared/types'

/**
 * 苹果CMS(MacCMS V10) 接口地址构造。
 * 同时支持「基地址 + 参数」和「模板地址（含 {ac} {wd} {pg} {t} {ids} 占位符）」两种写法。
 */

export interface CmsQuery {
  ac?: 'list' | 'detail' | 'videolist'
  wd?: string
  pg?: number | string
  t?: number | string
  ids?: number | string
  h?: string
}

const PLACEHOLDERS: Array<[keyof CmsQuery, RegExp]> = [
  ['ac', /\{ac\}/g],
  ['wd', /\{(wd|kw|key|keyword)\}/g],
  ['pg', /\{(pg|page)\}/g],
  ['t', /\{(t|type|typeid|class)\}/g],
  ['ids', /\{(ids|id)\}/g]
]

const API_PATH_ALTERNATES: Record<string, string[]> = {
  'caiji.dbzy5.com': ['/api.php/provide/vod/', '/api.php/provide/vod/from/dbm3u8/at/json/'],
  'cj.lziapi.com': ['/api.php/provide/vod/', '/api.php/provide/vod/from/lzyun/'],
  'cj.ffzyapi.com': ['/api.php/provide/vod/', '/api.php/provide/vod/from/ffm3u8/'],
  'suoniapi.com': ['/api.php/provide/vod/', '/api.php/provide/vod/at/xml/'],
  'cj.rycjapi.com': ['/api.php/provide/vod/from/rym3u8/', '/api.php/provide/vod/from/ryyun/'],
  'api.xinlangapi.com': ['/xinlangapi.php/provide/vod/', '/xinlangapi.php/provide/vod/from/xlyun/', '/xinlangapi.php/provide/vod/from/xlm3u8/'],
  'api.yparse.com': ['/api/m3u8/json'],
  'caiji.maotai999.vip': ['/api.php/provide/vod/', '/api.php/provide/vod/from/mtm3u8/at/josn/'],
  'm766.com': ['/api.php/provide/vod/at/json', '/api.php/provide/vod/at/xml/'],
  'ikunzyapi.com': ['/api.php/provide/vod/from/ikm3u8/at/json', '/api.php/provide/vod/']
}

const API_REFERERS: Record<string, string> = {
  'api.ffzyapi.com': 'https://ffzy5.tv/',
  'cj.ffzyapi.com': 'https://ffzy5.tv/',
  'cj.lziapi.com': 'https://lzizy.net/',
  'suoniapi.com': 'https://suonizy.net/',
  'haiwaikan.com': 'https://haiwaikan.com/',
  'www.hongniuzy2.com': 'https://hongniuzy.com/',
  'api.wujinapi.me': 'https://wujinzy.com/',
  'jszyapi.com': 'https://jisuzy1.com/',
  'cj.yayazy.net': 'https://yayazy.com/',
  'api.niuniuzy.me': 'https://niuniuzy.cc/',
  'sdzyapi.com': 'https://shandianzy.com/',
  'jyzyapi.com': 'https://jinyingzy.com/',
  'm3u8.apiyhzy.com': 'https://yhzy.cc/',
  'api.guangsuapi.com': 'https://www.guangsuzy.com/',
  'www.huyaapi.com': 'https://huyazy.com/',
  '360zyzz.com': 'https://360zy.com/',
  'api.juliang.live': 'https://juliang.app/',
  'iqiyizyapi.com': 'https://iqiyizy.com/',
  'api.maoyanapi.top': 'https://www.maoyanzy.com/',
  'caiji.dbzy5.com': 'https://dbzy.tv/',
  'api.okzyw.net': 'https://www.zzzypro.com/',
  'bfzyapi.com': 'https://bfzy2.tv/',
  'tyyszyapi.com': 'https://tyyszy.com/',
  'zuidazy.co': 'https://zuidazy.co/',
  'caiji.kuaichezy.org': 'https://kuaichezy.com/',
  'hhzyapi.com': 'https://haohuazy.com/',
  'api.xinlangapi.com': 'https://xinlangzy.com/',
  'api.wsyzy.net': 'https://www.wsyzy.cc/',
  'caiji.dyttzyapi.com': 'https://dyttzy.tv/',
  'api.ukuapi88.com': 'https://ukuzy.com/',
  'www.mdzyapi.com': 'https://moduzy.com/',
  'subocj.com': 'https://www.suboziyuan.net/',
  'api.apibdzy.com': 'https://bdzy.tv/',
  'cdn.dzzyapi.com': 'https://dzzy.com/',
  'cj.rycjapi.com': 'https://ryzy.tv/',
  'api.yparse.com': 'https://yparse.com/',
  'caiji.maotai999.vip': 'https://mtzy0.com/'
}

/** 保持 Android CMS 请求的候选顺序：主 API、站点备用路径、配置备用 API、备用域名。 */
export function cmsApiCandidates(site: Site): Site[] {
  const urls: string[] = [site.api]
  try {
    const primary = new URL(site.api)
    for (const path of API_PATH_ALTERNATES[primary.hostname.toLowerCase()] ?? []) {
      const alternate = new URL(primary.href)
      alternate.pathname = path
      urls.push(alternate.href)
    }
  } catch {
    // Keep the configured template as the first candidate.
  }

  urls.push(...(site.backupApi ?? []))
  try {
    const primary = new URL(site.api)
    for (const domain of site.backupDomain ?? []) {
      const alternate = new URL(domain)
      if (alternate.protocol !== 'http:' && alternate.protocol !== 'https:') continue
      alternate.pathname = primary.pathname || '/'
      alternate.search = ''
      alternate.hash = ''
      urls.push(alternate.href)
    }
  } catch {
    // Backup domains require an absolute primary API URL.
  }

  const unique = [...new Set(urls.map((url) => url.trim()).filter(Boolean))]
  return unique.map((api) => ({ ...site, api }))
}

export function cmsRefererForApi(api: string): string | undefined {
  try {
    return API_REFERERS[new URL(api).hostname.toLowerCase()]
  } catch {
    return undefined
  }
}

export function buildCmsUrl(site: Site, query: CmsQuery): string {
  const api = site.api ?? ''
  let templated = false
  let url = api

  for (const [key, re] of PLACEHOLDERS) {
    if (re.test(url)) {
      templated = true
      const value = query[key]
      url = url.replace(re, value === undefined ? '' : encodeURIComponent(String(value)))
    }
  }

  if (templated) {
    let out = url.replace(/\{h\}/g, String(query.h ?? ''))
    // 模板里没有 {ids} 槽位时，详情请求还是要能带上 ids：
    // 只替换不追加的话，`?ac={ac}&t={t}&pg={pg}&wd={wd}` 这种模板
    // 永远取不到详情页（实测桩上就是这个现象——点进去一直解析不出剧集）。
    if (query.ids !== undefined && !/[?&]ids=/.test(out)) {
      const sep = out.includes('?') ? (out.endsWith('?') || out.endsWith('&') ? '' : '&') : '?'
      out = `${out}${sep}ids=${encodeURIComponent(String(query.ids))}`
    }
    return out
  }

  // 基地址模式：安全拼接查询串
  const params = new URLSearchParams()
  if (query.ac) params.set('ac', query.ac)
  if (query.wd !== undefined) params.set('wd', query.wd)
  if (query.pg !== undefined) params.set('pg', String(query.pg))
  if (query.t !== undefined && query.t !== '') params.set('t', String(query.t))
  if (query.ids !== undefined) params.set('ids', String(query.ids))

  const qs = params.toString()
  if (!qs) return url
  const sep = url.includes('?') ? (url.endsWith('?') || url.endsWith('&') ? '' : '&') : '?'
  return `${url}${sep}${qs}`
}

/**
 * 分类浏览用的地址，和 buildCmsUrl 的区别是 t 可以传多个。
 *
 * 苹果CMS 把同一个大类拆成一堆叶子分类（电影 → 动作片/喜剧片/爱情片…），
 * 而**父分类 id 查不出任何东西**（实测 t=1 返回 0 条），只能落到叶子上。
 *
 * 注意：**不要指望把多个叶子 id 并列进同一次请求**。实测重复的 t 参数是
 * 「最后一个生效」而不是 OR——`t=6&t=7` 的 total 等于 t=7 的 total、返回的也全是
 * 喜剧片，`t=6,7` 则只认第一个。所以调用方（category.ts）对每个子分类单独发一次请求，
 * 拿回来自己合并；这里传多个 id 只是给模板式站点留个兜底。
 * 模板式站点只有一个 {t} 槽位，塞不下多个值，只取第一个叶子。
 */
export function buildCmsBrowseUrl(site: Site, ac: string, types: string[], pg: number): string {
  const api = site.api ?? ''
  // 只要地址里有任何占位符就算模板式。不能只认 {t}：像
  // `...?ac={ac}&pg={pg}&wd={wd}` 这种没有 {t} 的模板，如果走下面的「追加参数」
  // 分支，模板里的字面量 {ac}/{pg}/{wd} 会和新参数同时留在 URL 上，
  // 服务端读到哪一个完全看它先取哪个，等于随机。
  const templated = /\{(ac|wd|kw|key|keyword|pg|page|t|type|typeid|class|ids|id|h)\}/.test(api)
  if (templated) {
    return buildCmsUrl(site, { ac: ac as CmsQuery['ac'], t: types[0] ?? '', pg })
  }
  const params = new URLSearchParams()
  params.set('ac', ac)
  for (const t of types) if (t) params.append('t', t)
  params.set('pg', String(pg))
  const sep = api.includes('?') ? (api.endsWith('?') || api.endsWith('&') ? '' : '&') : '?'
  return `${api}${sep}${params.toString()}`
}

/** 归一化苹果CMS 返回，容忍 code 为 1 / "1" / "ok" 等写法 */
export function isCmsOk(payload: unknown): boolean {  if (!payload || typeof payload !== 'object') return false
  const code = (payload as Record<string, unknown>).code
  if (code === undefined || code === null || code === '') return true
  const s = String(code).toLowerCase()
  return s === '1' || s === 'true' || s === 'ok' || s === 'success' || s === '200'
}

export function asArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') return [value as T]
  return []
}
