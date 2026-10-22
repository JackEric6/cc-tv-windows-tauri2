import { createDecipheriv } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type {
  ConfigSource,
  HeaderRule,
  HtmlRules,
  ParseItem,
  ParsedConfig,
  Site,
  SiteType,
  NativeAdapter
} from '@shared/types'
import { fetchText, parseLooseJson } from './http'
import { decryptSensitiveText } from './sensitiveData'

/**
 * 配置解析层：同时吃 TVBox 兼容方言与本项目简洁方言。
 * 设计原则是「只做覆盖不做新增语义」——扩展字段对安卓 TVBox 无副作用。
 */

const STRING_TYPE_MAP: Record<string, SiteType> = {
  cms: 3,
  maccms: 3,
  apple: 3,
  apples: 3,
  '苹果cms': 3,
  api: 4,
  json: 4,
  html: 1,
  web: 1,
  rule: 1,
  rules: 1,
  page: 1,
  spider: 0,
  jar: 0,
  aggregate: 0,
  other: 2
}

/** 稳定短哈希，用于在没有 key 时生成站点标识 */
function shortHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function rightPad(value: string, length = 16): string {
  return value.trim().slice(0, length).padEnd(length, '0')
}

function resolveConfigUrl(raw: string, baseUrl?: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (/^(?:proxy|file|assets|clan|to):\/\//i.test(value)) return value
  try {
    if (/^https?:\/\//i.test(value)) return new URL(value).href
    if (baseUrl && /^(?:\.{0,2}\/|\/)/.test(value)) return new URL(value, baseUrl).href
  } catch {
    return value
  }
  return /^[^\s/]+\.[^\s/]+(?:\/|$)/u.test(value) ? `http://${value}` : value
}

function splitProtectedUrl(raw: string): { url: string; key?: string } {
  const marker = raw.indexOf(';pk;')
  if (marker < 0) return { url: raw }
  const url = raw.slice(0, marker).trim()
  const key = raw.slice(marker + 4).trim()
  return { url, key: key || undefined }
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

/** 饭太硬等入口页是导航 HTML，按钮里带有真实配置候选地址。 */
function portalConfigUrls(text: string, baseUrl: string): string[] {
  const candidates: string[] = []
  const pattern = /(?:data-clipboard-text|data-config-url|href)\s*=\s*["']([^"']+)["']/gi
  for (const match of text.matchAll(pattern)) {
    const raw = decodeHtmlAttribute(match[1]?.trim() ?? '')
    if (!/^https?:\/\//i.test(raw)) continue
    const resolved = resolveConfigUrl(raw, baseUrl)
    if (!resolved || resolved === baseUrl) continue
    if (!candidates.includes(resolved)) candidates.push(resolved)
  }
  return candidates
}

function nativeAdapterFor(rawApi: string, rawKey: string, rawName: string): NativeAdapter | undefined {
  const api = rawApi.trim().toLowerCase()
  const key = `${rawKey} ${rawName}`.toLowerCase()
  if (/csp_appgzguard/.test(api) || /(?:^|\s)瓜子(?:\s|$)/u.test(key)) return 'guazi'
  if (/csp_jpjguard/.test(api) || /(?:^|\s)(?:荐片|贱贱)(?:\s|$)/u.test(key)) return 'jianpian'
  if (/csp_newczguard/.test(api) || /厂长/u.test(key)) return 'cz4k'
  return undefined
}

function normalizeJar(raw: unknown, baseUrl?: string): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const [target, ...suffix] = raw.trim().split(';')
  const resolved = resolveConfigUrl(target, baseUrl)
  return [resolved, ...suffix].filter(Boolean).join(';') || undefined
}

function decryptHexAes(hex: string, mode: 'ecb' | 'cbc', key: string, iv?: string): string {
  const decipher = createDecipheriv(
    mode === 'ecb' ? 'aes-128-ecb' : 'aes-128-cbc',
    Buffer.from(rightPad(key), 'utf8'),
    mode === 'ecb' ? null : Buffer.from(rightPad(iv ?? ''), 'utf8')
  )
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8')
}

/** 对齐 TVBox ApiConfig.FindResult 的常见包装格式。 */
function decodeTvboxPayload(text: string, configKey?: string): unknown {
  const cleaned = text.replace(/^\uFEFF/, '').trim()
  try {
    return parseLooseJson(cleaned)
  } catch {
    // 某些配置先写入 8 个字符的标记，再把 JSON Base64 编码。
    const marker = /[A-Za-z0-9]{8}\*\*/.exec(cleaned)
    if (marker) {
      const encoded = cleaned.slice(marker.index + marker[0].length).replace(/\s+/g, '')
      try {
        return parseLooseJson(Buffer.from(encoded, 'base64').toString('utf8'))
      } catch {
        // 继续尝试下面的 AES 兼容格式。
      }
    }

    // TVBox 的 2423 格式：头部携带 key/iv，主体是十六进制密文。
    if (cleaned.startsWith('2423')) {
      const markerIndex = cleaned.indexOf('2324')
      if (markerIndex >= 0 && cleaned.length > markerIndex + 4 + 26) {
        const data = cleaned.slice(markerIndex + 4, -26)
        const ascii = Buffer.from(cleaned, 'hex').toString('utf8').toLowerCase()
        const keyStart = ascii.indexOf('$#')
        const keyEnd = ascii.indexOf('#$', keyStart + 2)
        if (keyStart >= 0 && keyEnd > keyStart) {
          try {
            return parseLooseJson(decryptHexAes(data, 'cbc', ascii.slice(keyStart + 2, keyEnd), ascii.slice(-13)))
          } catch {
            // 返回统一的格式错误，避免把密文当作站点 URL。
          }
        }
      }
    }

    // URL 的 ;pk; 后缀是 TVBox 的 AES-ECB 配置约定。
    if (configKey) {
      try {
        return parseLooseJson(decryptHexAes(cleaned.replace(/\s+/g, ''), 'ecb', configKey))
      } catch {
        // 由下面的统一错误提示收尾。
      }
    }
  }
  throw new Error('返回内容不是受支持的 TVBox JSON 配置')
}

function collectionUrl(raw: unknown, baseUrl: string): string | undefined {
  if (!isRecord(raw) || Object.prototype.hasOwnProperty.call(raw, 'sites') || !Array.isArray(raw.urls)) {
    return undefined
  }
  for (const item of raw.urls) {
    const value = typeof item === 'string'
      ? item
      : isRecord(item) ? String(item.url ?? item.api ?? '') : ''
    const url = resolveConfigUrl(value, baseUrl)
    if (/^https?:\/\//i.test(url)) return url
  }
  return undefined
}

function normalizeApi(raw: string, baseUrl?: string): string {
  const api = (raw ?? '').trim()
  if (!api) return ''
  if (/^https?:\/\//i.test(api)) return api
  if (/^(proxy|file|assets|clan|to):\/\//i.test(api)) return api
  if (baseUrl && /^(?:\.{0,2}\/|\/)/.test(api)) {
    try {
      return new URL(api, baseUrl).href
    } catch {
      return api
    }
  }
  // 形如 cms1.example.com/api.php/provide/vod/ 的裸域名
  if (/^[^\s/]+\.[^\s/]+(?:\/|$)/u.test(api)) return `https://${api}`
  return api
}

function normalizeType(raw: unknown, api: string, rules?: HtmlRules): SiteType {
  if (typeof raw === 'number' && [0, 1, 2, 3, 4].includes(raw)) return raw as SiteType
  if (typeof raw === 'string') {
    const key = raw.trim().toLowerCase()
    if (key) {
      const mapped = STRING_TYPE_MAP[key]
      if (mapped !== undefined) return mapped
      const asNum = Number(key)
      if (Number.isInteger(asNum) && asNum >= 0 && asNum <= 4) return asNum as SiteType
      // 配置里明确写了类型但我们不认识：如实标成「未知」，
      // 不要偷偷降级成 type=4（CMS 变体），否则 UI 会给出错误的可用性承诺。
      return 2
    }
  }
  // 完全没有类型信息时才按内容猜测
  if (rules && (rules.list || rules.search)) return 1
  if (/provide\/vod|api\.php|\/vod\//i.test(api)) return 3
  if (api) return 4
  return 2
}

function flag(raw: unknown, fallback = false): boolean {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'boolean') return raw
  const n = Number(raw)
  if (!Number.isNaN(n)) return n !== 0
  const s = String(raw).toLowerCase()
  return s === 'true' || s === 'yes' || s === '1'
}

function normalizeRules(raw: unknown): HtmlRules | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = r[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return undefined
  }
  const rules: HtmlRules = {
    list: pick('list', 'vodList', 'listRule'),
    name: pick('name', 'vodName', 'title'),
    link: pick('link', 'vodLink', 'href'),
    pic: pick('pic', 'vodPic', 'image'),
    remarks: pick('remarks', 'vodRemarks', 'note'),
    search: pick('search', 'searchUrl'),
    detailName: pick('detailName'),
    detailContent: pick('detailContent', 'content'),
    playList: pick('playList', 'playFrom'),
    playItem: pick('playItem', 'playUrl')
  }
  const cleaned = Object.fromEntries(
    Object.entries(rules).filter(([, v]) => typeof v === 'string' && v)
  ) as HtmlRules
  return Object.keys(cleaned).length ? cleaned : undefined
}

export interface SiteNormalizeContext {
  sourceId: string
  sourceName: string
  defaults?: { timeout?: number; header?: Record<string, string> }
  /** 用于把 TVBox 配置中的相对接口地址解析成绝对地址。 */
  baseUrl?: string
}

export function normalizeSite(input: unknown, ctx: SiteNormalizeContext): Site | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, any>
  const name = String(raw.name ?? raw.title ?? '').trim()
  const rawApi = String(raw.api ?? raw.url ?? raw.ext?.api ?? '')
  const api = normalizeApi(rawApi, ctx.baseUrl)
  if (!name && !api) return null

  const rules = normalizeRules(raw.rules ?? raw.ext?.rules)
  const type = normalizeType(raw.type, api, rules)
  const key = String(raw.key ?? raw.id ?? `csp_${shortHash(`${name}|${api}`)}`).trim()
  const nativeAdapter = nativeAdapterFor(rawApi, key, name)

  const site: Site = {
    key,
    name: name || key,
    type,
    api,
    backupApi: Array.isArray(raw.backupApi) ? raw.backupApi.map(String).map((value: string) => value.trim()).filter(Boolean) : undefined,
    backupDomain: Array.isArray(raw.backupDomain) ? raw.backupDomain.map(String).map((value: string) => value.trim()).filter(Boolean) : undefined,
    ext: typeof raw.ext === 'string' ? raw.ext : raw.ext ? JSON.stringify(raw.ext) : undefined,
    jar: normalizeJar(raw.jar, ctx.baseUrl),
    nativeAdapter,
    searchable: flag(raw.searchable, true),
    homeEnabled: true,
    searchEnabled: flag(raw.searchable, true),
    categoryEnabled: true,
    quickSearch: flag(raw.quickSearch, flag(raw.searchable, true)),
    filterable: flag(raw.filterable, type === 3 || type === 4),
    playerType: Number(raw.playerType ?? 1) || 1,
    categories: Array.isArray(raw.categories) ? raw.categories.map(String) : undefined,
    style:
      raw.style && typeof raw.style === 'object'
        ? { type: raw.style.type, ratio: Number(raw.style.ratio) || undefined }
        : undefined,
    header: {
      ...(ctx.defaults?.header ?? {}),
      ...(raw.header && typeof raw.header === 'object' ? raw.header : {})
    },
    timeout: Number(raw.timeout) || ctx.defaults?.timeout,
    sourceId: ctx.sourceId,
    sourceName: ctx.sourceName,
    enabled: flag(raw.enabled, true),
    rules
  }
  if (!Object.keys(site.header ?? {}).length) delete site.header

  // 桌面端不支持的能力，显式标注原因，UI 上灰显而不是静默丢弃
  if (!site.api || /^(proxy|assets|file|clan|to):/i.test(site.api)) {
    site.unsupported = '该站点依赖内置 Spider 或本地资源，桌面端无法直接请求'
    site.searchable = false
    site.quickSearch = false
  } else if (type === 0 || (!/^https?:\/\//i.test(site.api) && !nativeAdapter)) {
    site.unsupported = '需要配套 Spider（jar/dex），桌面端无法运行'
    site.searchable = false
    site.quickSearch = false
  } else if (type === 2) {
    site.unsupported = '未知站点类型，暂不支持'
    site.searchable = false
    site.quickSearch = false
  }
  if (site.key === 'cz4k' || site.key === 'ryzy') {
    site.searchable = false
    site.searchEnabled = false
    site.quickSearch = false
  }
  return site
}

function normalizeParses(raw: unknown, baseUrl?: string): ParseItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item): ParseItem | null => {
      if (!item || typeof item !== 'object') return null
      const p = item as Record<string, any>
      const url = resolveConfigUrl(String(p.url ?? ''), baseUrl)
      if (!url) return null
      return {
        name: String(p.name ?? '未命名解析'),
        type: Number(p.type ?? 1) || 1,
        url,
        ext: p.ext
      }
    })
    .filter((x): x is ParseItem => x !== null)
}

function normalizeHeaderRules(raw: unknown): HeaderRule[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item): HeaderRule | null => {
      if (!item || typeof item !== 'object') return null
      const h = item as Record<string, any>
      if (!h.host || !h.header) return null
      return { host: String(h.host), header: h.header as Record<string, string> }
    })
    .filter((x): x is HeaderRule => x !== null)
}

/** 把任意一份配置 JSON 归一化成内部结构 */
export function parseConfig(rawInput: unknown, ctx: SiteNormalizeContext): ParsedConfig {
  const raw = isRecord(rawInput) ? rawInput : {}
  const ext = (raw.tvboxDesktop ?? {}) as Record<string, any>
  const settings = (raw.settings ?? {}) as Record<string, any>

  const defaults = {
    timeout: Number(ext.timeout ?? settings.timeout ?? ctx.defaults?.timeout) || undefined,
    header: {
      ...(ctx.defaults?.header ?? {}),
      ...(raw.header && typeof raw.header === 'object' ? raw.header : {})
    }
  }

  const sitesRaw = Array.isArray(raw.sites) ? raw.sites : []
  const seen = new Set<string>()
  const sites: Site[] = []
  for (const item of sitesRaw) {
    const site = normalizeSite(item, { ...ctx, defaults })
    if (!site) continue
    if (seen.has(site.key)) continue
    seen.add(site.key)
    sites.push(site)
  }

  return {
    name: String(raw.name ?? ext.name ?? ctx.sourceName ?? '未命名配置'),
    notice: raw.notice ? String(raw.notice) : undefined,
    sites,
    parses: normalizeParses(raw.parses, ctx.baseUrl),
    flags: Array.isArray(raw.flags) ? raw.flags.map(String) : [],
    headers: normalizeHeaderRules(raw.headers ?? settings.headers),
    theme: (raw.theme ?? ext.theme) as ParsedConfig['theme'],
    externalPlayer: (raw.externalPlayer ?? ext.externalPlayer) as ParsedConfig['externalPlayer'],
    home: (raw.home ?? ext.home) as ParsedConfig['home'],
    raw: rawInput
  }
}

/** 拉取（或读取本地）一份配置源，返回归一化结果 */
export async function loadConfigSource(
  source: Pick<ConfigSource, 'id' | 'name' | 'url' | 'kind'>,
  timeout = 20
): Promise<ParsedConfig> {
  const visited = new Set<string>()
  const load = async (rawUrl: string, kind: 'url' | 'file', depth: number): Promise<ParsedConfig> => {
    const protectedUrl = splitProtectedUrl(rawUrl)
    const baseUrl = resolveConfigUrl(protectedUrl.url)
    const visitKey = `${kind}:${baseUrl};pk;${protectedUrl.key ?? ''}`
    if (visited.has(visitKey)) throw new Error('配置链接存在循环引用')
    if (depth > 4) throw new Error('配置链接嵌套层级超过 4 层')
    visited.add(visitKey)

    const fileText = kind === 'file' && depth === 0
      ? await fs.readFile(protectedUrl.url, 'utf-8')
      : undefined
    const text = fileText === undefined
      ? await fetchText(baseUrl, { timeout })
      : decryptSensitiveText(fileText)
    let json: unknown
    try {
      json = decodeTvboxPayload(text, protectedUrl.key)
    } catch (error) {
      const candidates = portalConfigUrls(text, baseUrl)
      if (!candidates.length) throw error
      let lastError = error as Error
      for (const candidate of candidates) {
        try {
          return await load(candidate, 'url', depth + 1)
        } catch (candidateError) {
          lastError = candidateError as Error
        }
      }
      throw new Error(`配置导航页中的候选地址均不可用：${lastError.message}`)
    }
    const nextUrl = collectionUrl(json, baseUrl)
    if (nextUrl) return load(nextUrl, 'url', depth + 1)
    return parseConfig(json, {
      sourceId: source.id,
      sourceName: source.name,
      defaults: { timeout },
      baseUrl
    })
  }

  return load(source.url, source.kind, 0)
}
