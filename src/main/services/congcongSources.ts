import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID
} from 'node:crypto'
import type { Episode, Line, Site, Vod, VodDetail } from '@shared/types'
import { matchesFullSearchKeyword } from '@shared/searchMatch'
import { networkFetch, parseLooseJson } from './http'
import { readStore, writeStore } from './store'

const GUAZI_ORIGIN = 'https://api.anctjd.com'
const GUAZI_VERSION = '3.0.5.2'
const GUAZI_PACKAGE = 'com.xcf8fa289d.s53f6f7725.hc2d9bb51620260914'
const GUAZI_VERSION_CODE = '2608011'
const GUAZI_SALT = '*&zvdvdvddbfikkkumtmdwqppp?|4Y!s!2br'
const GUAZI_HOME_PID = '3'
const GUAZI_HOME_SHOW_ID = '46296'
const GUAZI_PUBLIC_KEY =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDUM5+/y8sPsWkd1/RQS64X259EUwxFXFE5HlA65MqrxnPs0JqoSRojSDy5QhwvROlaD6TwRQHKMY2OAZ6SnQeUJsChTEFIR9qUkwrs3/MVUMxjsv6JS6Oe/juclyJGTgVmDhB55EafXsD0SQYVj/QXXsxR6ewR5E2kL52yAAD4yQIDAQAB'
const GUAZI_PRIVATE_KEY =
  'MIICdgIBADANBgkqhkiG9w0BAQEFAASCAmAwggJcAgEAAoGAe6hKrWLi1zQmjTT1ozbE4QdFeJGNxubxld6GrFGximxfMsMB6BpJhpcTouAqywAFppiKetUBBbXwYsYU1wNr648XVmPmCMCy4rY8vdliFnbMUj086DU6Z+/oXBdWU3/b1G0DN3E9wULRSwcKZT3wj/cCI1vsCm3gj2R5SqkA9Y0CAwEAAQKBgAJH+4CxV0/zBVcLiBCHvSANm0l7HetybTh/j2p0Y1sTXro4ALwAaCTUeqdBjWiLSo9lNwDHFyq8zX90+gNxa7c5EqcWV9FmlVXr8VhfBzcZo1nXeNdXFT7tQ2yah/odtdcx+vRMSGJd1t/5k5bDd9wAvYdIDblMAg+wiKKZ5KcdAkEA1cCakEN4NexkF5tHPRrR6XOY/XHfkqXxEhMqmNbB9U34saTJnLWIHC8IXys6Qmzz30TtzCjuOqKRRy+FMM4TdwJBAJQZFPjsGC+RqcG5UvVMiMPhnwe/bXEehShK86yJK/g/UiKrO87h3aEu5gcJqBygTq3BBBoH2md3pr/W+hUMWBsCQQChfhTIrdDinKi6lRxrdBnn0Ohjg2cwuqK5zzU9p/N+S9x7Ck8wUI53DKm8jUJE8WAG7WLj/oCOWEh+ic6NIwTdAkEAj0X8nhx6AXsgCYRql1klbqtVmL8+95KZK7PnLWG/IfjQUy3pPGoSaZ7fdquG8bq8oyf5+dzjE/oTXcByS+6XRQJAP/5ciy1bL3NhUhsaOVy55MHXnPjdcTX0FaLi+ybXZIfIQ2P4rb19mVq1feMbCXhz+L1rG8oat5lYKfpe8k83ZA=='

const GUAZI_TOKEN_KEY = 'congcong-guazi-token'
const GUAZI_DEVICE_KEY = 'congcong-guazi-device'
const GUAZI_SIGNUP_DEVICE_KEY = 'congcong-guazi-signup-device'
const JIANPIAN_IMAGE_ORIGIN = 'https://img.ypfbj.com'
const JIANPIAN_PRIMARY_HOST = 'cqjdn.com'
const JIANPIAN_DISCOVERY_URL = 'https://ssopj-1462720388.cos.accelerate.myqcloud.com/config.txt'
const JIANPIAN_DEFAULT_HOSTS = [
  'cqjdn.com', 'bdgnbrws.com', 'fvevfbr.com', 'swgsdfew.com', 'hodpj.cc',
  'fan123.hzhnl.com', 'jianpian.com', 'jianpian25.com'
]
const JIANPIAN_DISCOVERY_TTL = 10 * 60 * 1000
const JIANPIAN_SEARCH_CACHE_TTL = 30 * 1000
const JIANPIAN_SEARCH_CACHE_LIMIT = 24
const GUAZI_CONTENT_FIELDS = [
  'vod_use_content', 'd_content', 'd_blurb', 'd_desc', 'd_description', 'd_detail', 'd_intro', 'd_synopsis', 'd_summary', 'd_plot',
  'vod_content', 'vod_blurb', 'vod_desc', 'vod_description', 'vod_detail', 'vod_intro', 'vod_summary', 'vod_plot', 'synopsis', 'summary',
  'intro', 'introduction', 'description', 'desc', 'content', 'plot', 'story', 'storyline', 'brief', 'about'
]
const GUAZI_CONTENT_CONTAINERS = [
  'detail', 'details', 'data', 'result', 'payload', 'vod', 'vod_info', 'vodInfo', 'vod_detail', 'vodDetail',
  'd_info', 'info', 'item', 'video', 'video_info', 'response', 'body'
]
const guaziMetadata = new Map<string, Record<string, unknown>>()
const jianpianSearchCache = new Map<string, { createdAt: number; value: Record<string, any> }>()
let cachedGuaziToken = ''
let tokenLoad: Promise<string> | undefined
let lastSuccessfulJianpianOrigin = ''
let discoveredJianpianOrigins: string[] = []
let jianpianDiscoveryCheckedAt = 0
let jianpianDiscovery: Promise<string[]> | undefined

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

function firstText(value: Record<string, any>, ...keys: string[]): string {
  for (const key of keys) {
    const item = value[key]
    if (item === undefined || item === null) continue
    if (Array.isArray(item)) {
      const joined = item.map((part) => (typeof part === 'object' ? firstText(asObject(part), 'name', 'title') : String(part))).filter(Boolean).join(',')
      if (joined) return joined
    } else if (typeof item === 'object') {
      const nested = firstText(asObject(item), 'name', 'title', 'url')
      if (nested) return nested
    } else {
      const text = String(item).trim()
      if (text) return text
    }
  }
  return ''
}

function firstTextDeep(value: Record<string, any>, ...keys: string[]): string {
  for (const key of keys) {
    const direct = firstText(value, key)
    if (direct) return direct
    for (const container of GUAZI_CONTENT_CONTAINERS) {
      const nested = value[container]
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue
      const found = firstTextDeep(nested as Record<string, any>, key)
      if (found) return found
    }
  }
  return ''
}

function guaziContentValue(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map((item) => guaziContentValue(item, depth + 1)).filter(Boolean).join('\n')
  if (typeof value !== 'object') return ''

  const object = value as Record<string, unknown>
  for (const key of ['text', 'html', 'content', 'description', 'desc', 'intro', 'summary', 'value', 'data', 'result', 'info']) {
    const result = guaziContentValue(object[key], depth + 1)
    if (result) return result
  }
  return ''
}

function findGuaziContent(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findGuaziContent(item, depth + 1)
      if (result) return result
    }
    return ''
  }
  if (typeof value !== 'object') return ''

  const object = value as Record<string, unknown>
  for (const key of GUAZI_CONTENT_FIELDS) {
    const result = guaziContentValue(object[key])
    if (result) return result
  }
  for (const key of GUAZI_CONTENT_CONTAINERS) {
    const child = object[key]
    if (!child || typeof child !== 'object') continue
    const result = findGuaziContent(child, depth + 1)
    if (result) return result
  }
  return ''
}

function firstArray(value: Record<string, any>, ...keys: string[]): any[] {
  for (const key of keys) if (Array.isArray(value[key])) return value[key] as any[]
  return []
}

function unwrap(value: unknown, ...keys: string[]): Record<string, any> {
  const object = asObject(value)
  for (const key of keys) {
    const nested = object[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, any>
  }
  return object
}

function absoluteImage(value: string, origin = ''): string {
  const image = value.trim().replace(/&amp;/gi, '&')
  if (!image) return ''
  if (image.startsWith('//')) return `https:${image}`
  if (/^(?:https?:|data:image\/)/i.test(image)) return image
  if (!origin) return image
  try {
    return new URL(image, `${origin.replace(/\/$/, '')}/`).toString()
  } catch {
    return `${origin}${image.startsWith('/') ? '' : '/'}${image}`
  }
}

function extractJianpianImage(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = extractJianpianImage(item, depth + 1)
      if (image) return image
    }
    return ''
  }
  if (typeof value !== 'object') return ''
  const image = asObject(value)
  for (const key of [
    'url', 'src', 'uri', 'image_url', 'img_url', 'thumb_url', 'poster_url', 'cover_url', 'original',
    'large', 'big', 'full', 'full_url', 'thumb', 'thumbnail', 'tvimg', 'cover', 'poster', 'pic', 'img', 'image', 'path', 'value'
  ]) {
    const nested = extractJianpianImage(image[key], depth + 1)
    if (nested) return nested
  }
  return ''
}

function jianpianPoster(raw: Record<string, any>): string {
  for (const field of [
    'poster_url', 'poster_path', 'cover_url', 'cover_pic', 'cover_img', 'video_cover', 'poster', 'cover',
    'pic_url', 'small_pic', 'pic', 'image', 'image_url', 'image_path', 'img_url', 'thumb_url',
    'thumb', 'thumbnail', 'tvimg', 'img', 'vod_img', 'vod_pic'
  ]) {
    const image = extractJianpianImage(raw[field])
    if (image) return absoluteImage(image, JIANPIAN_IMAGE_ORIGIN)
  }
  return ''
}

function makeVod(raw: Record<string, any>, site: Site, kind: 'guazi' | 'jianpian'): Vod {
  if (kind === 'jianpian') {
    const id = firstText(raw, 'id', 'work_id', 'video_id')
    return {
      vod_id: id,
      vod_name: firstText(raw, 'title', 'name', 'original_name') || id,
      vod_pic: jianpianPoster(raw),
      vod_remarks: firstText(raw, 'mask', 'remarks', 'badge', 'episodes_count'),
      vod_year: firstText(raw, 'year', 'release_year'),
      vod_area: firstText(raw, 'areas', 'area', 'region'),
      vod_actor: firstText(raw, 'actors', 'actor'),
      vod_director: firstText(raw, 'directors', 'director'),
      type_name: firstText(raw, 'types', 'category', 'kind'),
      vod_score: firstText(raw, 'score', 'rating'),
      siteKey: site.key,
      siteName: site.name,
      sourceId: site.sourceId
    }
  }

  const get = (...keys: string[]): string => firstTextDeep(raw, ...keys)
  const id = get('vod_id', 'd_id', 'id', 'show_id', 'vodId')
  return {
    vod_id: id,
    vod_name: get('vod_name', 'd_name', 'c_name', 'name', 'title', 'vod_title') || id,
    vod_pic: absoluteImage(get('vod_pic', 'd_pic', 'c_pic', 'pic'), GUAZI_ORIGIN),
    vod_remarks: get('new_continue', 'vod_remarks', 'vod_title', 'cf_name', 'sub_title'),
    vod_year: get('vod_year', 'd_year', 'year'),
    vod_area: get('vod_area', 'd_area', 'area', 'region'),
    vod_actor: get('vod_actor', 'd_actor', 'vod_actors', 'actors', 'actor', 'starring', 'cast'),
    vod_director: get('vod_director', 'vod_directed', 'd_director', 'director'),
    type_name: get('vod_class', 'd_type', 'd_class', 'type_name', 'category'),
    vod_score: get('vod_scroe', 'vod_score', 'vod_douban_score', 'score', 'rating'),
    siteKey: site.key,
    siteName: site.name,
    sourceId: site.sourceId
  }
}

function resolveImageField(value: string): string {
  return absoluteImage(value, JIANPIAN_IMAGE_ORIGIN)
}

function mapJianpianEpisode(value: unknown, index: number): Episode | null {
  const episode = unwrap(value, 'episode', 'item')
  const url = firstText(episode, 'url', 'play_url', 'playback_url', 'media_url')
  if (!url) return null
  let name = firstText(episode, 'source_name', 'weight', 'name', 'title', 'sort')
  if (!name) name = `第${index + 1}集`
  else if (/^\d+$/.test(name)) name = `第${name}集`
  return { name, url, index }
}

function mapJianpianLines(raw: Record<string, any>): Line[] {
  const grouped = new Map<string, Episode[]>()
  for (const field of ['source_list_source', 'vip_source_list_source']) {
    for (const lineValue of firstArray(raw, field)) {
      const line = unwrap(lineValue, 'line', 'provider')
      const name = firstText(line, 'name', 'source_name', 'title') || '荐片线路'
      const episodes = firstArray(line, 'source_list', 'episodes', 'list')
        .map((entry, index) => mapJianpianEpisode(entry, index))
        .filter((entry): entry is Episode => Boolean(entry))
      if (!episodes.length) continue
      const current = grouped.get(name) ?? []
      const seen = new Set(current.map((entry) => entry.url))
      for (const episode of episodes) if (!seen.has(episode.url) && current.length < 1200) current.push(episode)
      if (!grouped.has(name) && grouped.size < 4) grouped.set(name, current)
    }
  }
  if (!grouped.size) {
    const episodes = firstArray(raw, 'ftp_list')
      .map((entry, index) => mapJianpianEpisode(entry, index))
      .filter((entry): entry is Episode => Boolean(entry))
    if (episodes.length) grouped.set('FTP线路', episodes)
  }
  return [...grouped.entries()].map(([name, episodes]) => ({ name, episodes }))
}

function toDetail(vod: Vod, content: string, lines: Line[]): VodDetail {
  const cleanContent = content.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").trim()
  return { ...vod, vod_content: cleanContent, lines }
}

async function fetchJson(url: string, options: RequestInit = {}): Promise<Record<string, any>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25000)
  try {
    const response = await networkFetch(url, {
      ...options,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        ...(options.headers as Record<string, string> | undefined)
      },
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return asObject(parseLooseJson(text))
  } catch (error) {
    const err = error as Error
    if (err.name === 'AbortError') throw new Error('请求超时（25s）')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function normalizeJianpianOrigin(value: string): string {
  let text = value.trim().replace(/^['"]|['"]$/g, '')
  if (!text) return ''
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return ''
    return url.origin
  } catch {
    return ''
  }
}

async function discoverJianpianOrigins(): Promise<string[]> {
  const now = Date.now()
  if (now - jianpianDiscoveryCheckedAt < JIANPIAN_DISCOVERY_TTL) return discoveredJianpianOrigins
  if (jianpianDiscovery) return jianpianDiscovery

  jianpianDiscoveryCheckedAt = now
  jianpianDiscovery = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    try {
      const response = await networkFetch(JIANPIAN_DISCOVERY_URL, {
        headers: { Accept: 'text/plain, */*', 'User-Agent': 'Mozilla/5.0 packageName:com.jp3.xg3' },
        signal: controller.signal
      })
      if (!response.ok) return discoveredJianpianOrigins
      const body = await response.text()
      discoveredJianpianOrigins = [...new Set(body.split(/[,\s]+/).map(normalizeJianpianOrigin).filter(Boolean))]
      return discoveredJianpianOrigins
    } catch {
      return discoveredJianpianOrigins
    } finally {
      clearTimeout(timer)
      jianpianDiscovery = undefined
    }
  })()
  return jianpianDiscovery
}

async function jianpianCandidateOrigins(): Promise<string[]> {
  return [...new Set([
    lastSuccessfulJianpianOrigin,
    ...JIANPIAN_DEFAULT_HOSTS.map((host) => normalizeJianpianOrigin(host))
  ].filter(Boolean))]
}

async function fetchJianpianOrigin(
  origin: string,
  path: string,
  query: URLSearchParams,
  timeout: number,
  failures: string[],
  parentSignal?: AbortSignal
): Promise<Record<string, any> | null> {
  const controller = new AbortController()
  const abortFromParent = (): void => controller.abort()
  if (parentSignal?.aborted) controller.abort()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const url = new URL(path, `${origin}/`)
    query.forEach((value, key) => url.searchParams.set(key, value))
    const response = await networkFetch(url, {
      headers: {
        Accept: 'application/json',
        Referer: `${origin}/`,
        'User-Agent': 'Mozilla/5.0 packageName:com.jp3.xg3'
      },
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const parsed = parseLooseJson(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('荐片接口返回了无效 JSON')
    }
    lastSuccessfulJianpianOrigin = origin
    return parsed as Record<string, any>
  } catch (error) {
    const err = error as Error
    const message = err.name === 'AbortError' ? `请求超时（${Math.round(timeout / 1000)}s）` : err.message
    failures.push(`${new URL(origin).hostname} ${message}`)
    if (origin === lastSuccessfulJianpianOrigin) lastSuccessfulJianpianOrigin = ''
    return null
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abortFromParent)
  }
}

async function raceJianpianOrigins(
  origins: string[],
  path: string,
  query: URLSearchParams,
  timeout: number,
  failures: string[],
  signal: AbortSignal,
  attempted: Set<string>
): Promise<Record<string, any>> {
  const candidates = [...new Set(origins)].filter((origin) => {
    if (attempted.has(origin)) return false
    attempted.add(origin)
    return true
  })
  if (!candidates.length) throw new Error('没有新的荐片备用域名')
  const raceController = new AbortController()
  const raceSignal = AbortSignal.any([signal, raceController.signal])
  try {
    return await Promise.any(candidates.map(async (origin) => {
      const result = await fetchJianpianOrigin(origin, path, query, timeout, failures, raceSignal)
      if (!result) throw new Error(`荐片域名不可用：${new URL(origin).hostname}`)
      return result
    }))
  } finally {
    raceController.abort()
  }
}

async function fetchJianpianJson(
  path: string,
  query: URLSearchParams,
  timeoutOverride?: number,
  parentSignal?: AbortSignal
): Promise<Record<string, any>> {
  const isSearch = path === '/api/v2/search/videoV2'
  const primaryTimeout = Math.min(timeoutOverride ?? (isSearch ? 6000 : 8000), isSearch ? 6000 : 8000)
  const fallbackTimeout = Math.min(timeoutOverride ?? (isSearch ? 4000 : 6000), isSearch ? 4000 : 6000)
  const cacheKey = path === '/api/v2/search/videoV2' ? `${path}?${query.toString()}` : ''
  if (cacheKey) {
    const cached = jianpianSearchCache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt <= JIANPIAN_SEARCH_CACHE_TTL) {
      jianpianSearchCache.delete(cacheKey)
      jianpianSearchCache.set(cacheKey, cached)
      return JSON.parse(JSON.stringify(cached.value)) as Record<string, any>
    }
    if (cached) jianpianSearchCache.delete(cacheKey)
  }

  const failures: string[] = []
  const attempted = new Set<string>()
  const primary = normalizeJianpianOrigin(lastSuccessfulJianpianOrigin || JIANPIAN_PRIMARY_HOST)
  const discovery = discoverJianpianOrigins()
  const knownOrigins = (await jianpianCandidateOrigins()).filter((origin) => origin !== primary)
  let parsed: Record<string, any> | null = null
  const raceController = new AbortController()
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, raceController.signal])
    : raceController.signal
  try {
    const candidates = [
      raceJianpianOrigins([primary, ...knownOrigins], path, query, primaryTimeout, failures, signal, attempted),
      discovery.then((origins) =>
        raceJianpianOrigins(origins, path, query, fallbackTimeout, failures, signal, attempted)
      )
    ]
    parsed = await Promise.any(candidates)
  } catch {
    parsed = null
  } finally {
    raceController.abort()
  }
  if (!parsed) throw new Error(`荐片接口候选域名均请求失败：${failures.join('；') || '没有可用域名'}`)
  if (cacheKey) {
    jianpianSearchCache.set(cacheKey, { createdAt: Date.now(), value: parsed })
    if (jianpianSearchCache.size > JIANPIAN_SEARCH_CACHE_LIMIT) {
      const oldest = jianpianSearchCache.keys().next().value
      if (oldest) jianpianSearchCache.delete(oldest)
    }
  }
  return parsed
}

function randomText(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = randomBytes(length)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

function aesEncrypt(value: string, key: string, iv: string): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv))
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('hex').toUpperCase()
}

function aesDecrypt(value: string, key: string, iv: string): string {
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv))
  return Buffer.concat([decipher.update(Buffer.from(value, 'hex')), decipher.final()]).toString('utf8')
}

function rsaEncrypt(value: string): string {
  const key = createPublicKey({ key: Buffer.from(GUAZI_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' })
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(value)).toString('base64')
}

function rsaDecrypt(value: string): string {
  const key = createPrivateKey({ key: Buffer.from(GUAZI_PRIVATE_KEY, 'base64'), format: 'der', type: 'pkcs8' })
  return privateDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(value, 'base64')).toString('utf8')
}

function createGuaziForm(params: Record<string, unknown>, token: string): URLSearchParams {
  const key = randomText(16)
  const iv = randomText(16)
  const requestKey = aesEncrypt(JSON.stringify(params), key, iv)
  const keys = rsaEncrypt(JSON.stringify({ key, iv }))
  const time = Math.floor(Date.now() / 1000)
  const signatureText = `token_id=,token=${token},phone_type=1,request_key=${requestKey},app_id=1,time=${time},keys=${keys}`
  const signature = createHash('md5').update(signatureText + GUAZI_SALT).digest('hex').toUpperCase()
  return new URLSearchParams({
    token,
    token_id: '',
    phone_type: '1',
    time: String(time),
    phone_model: 'Windows Desktop',
    keys,
    request_key: requestKey,
    signature,
    app_id: '1',
    ad_version: '1'
  })
}

async function performGuaziRequest(
  path: string,
  params: Record<string, unknown>,
  token: string,
  parentSignal?: AbortSignal,
  timeoutMs = 25_000
): Promise<any> {
  const response = await networkFetch(`${GUAZI_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'api-ver': GUAZI_VERSION,
      code: 'GZ0007',
      lang: 'zh_cn',
      PackageName: GUAZI_PACKAGE,
      Ver: GUAZI_VERSION,
      Version: GUAZI_VERSION_CODE,
      Referer: GUAZI_ORIGIN
    },
    body: createGuaziForm(params, token),
    signal: parentSignal
      ? AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)
  })
  const raw = await response.text()
  const outer = asObject(parseLooseJson(raw))
  const code = Number(outer.code ?? response.status)
  const message = String(outer.msg ?? '')
  if (!response.ok || code !== 200) {
    const error = new Error(`瓜子接口错误：${message || `HTTP ${response.status}`}`)
    if (code === 401 || code === 403 || /token/i.test(message)) error.name = 'GuaziAuthError'
    throw error
  }
  const data = asObject(outer.data)
  if (!data.keys || !data.response_key) return data
  const session = asObject(parseLooseJson(rsaDecrypt(String(data.keys))))
  return parseLooseJson(aesDecrypt(String(data.response_key), String(session.key), String(session.iv)))
}

async function registerGuaziDevice(): Promise<string> {
  const oldKey = await readStore<string>(GUAZI_DEVICE_KEY, '') || `windows-${randomUUID().replaceAll('-', '')}`
  await writeStore(GUAZI_DEVICE_KEY, oldKey)
  let signupKey = await readStore<string>(GUAZI_SIGNUP_DEVICE_KEY, '')
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!signupKey) signupKey = `cc-tv-${randomUUID().replaceAll('-', '')}`
    try {
      const response = asObject(await performGuaziRequest('/App/Authentication/Device/signUp', {
        old_key: oldKey,
        new_key: signupKey,
        phone_type: '1',
        code: ''
      }, ''))
      const token = firstText(response, 'token')
      if (token) {
        await writeStore(GUAZI_SIGNUP_DEVICE_KEY, signupKey)
        await writeStore(GUAZI_TOKEN_KEY, token)
        cachedGuaziToken = token
        return token
      }
    } catch (error) {
      if ((error as Error).name !== 'GuaziAuthError') throw error
    }
    signupKey = `cc-tv-${randomUUID().replaceAll('-', '')}`
  }
  throw new Error('瓜子设备注册失败')
}

async function getGuaziToken(): Promise<string> {
  if (cachedGuaziToken) return cachedGuaziToken
  if (!tokenLoad) {
    tokenLoad = (async () => {
      cachedGuaziToken = await readStore<string>(GUAZI_TOKEN_KEY, '')
      return cachedGuaziToken || registerGuaziDevice()
    })().finally(() => {
      tokenLoad = undefined
    })
  }
  return tokenLoad
}

async function guaziRequest(
  path: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 25_000
): Promise<any> {
  const token = await getGuaziToken()
  signal?.throwIfAborted()
  try {
    return await performGuaziRequest(path, params, token, signal, timeoutMs)
  } catch (error) {
    if ((error as Error).name !== 'GuaziAuthError') throw error
    cachedGuaziToken = ''
    await writeStore(GUAZI_TOKEN_KEY, '')
    signal?.throwIfAborted()
    return performGuaziRequest(path, params, await registerGuaziDevice(), signal, timeoutMs)
  }
}

function guaziList(value: unknown): any[] {
  const object = unwrap(value, 'data', 'result', 'payload')
  return firstArray(object, 'list', 'items', 'vod_list')
}

function mapGuaziList(value: unknown, site: Site, limit: number, keyword = ''): Vod[] {
  return guaziList(value).map((item) => {
    const raw = unwrap(item, 'vod', 'item')
    const vod = makeVod(raw, site, 'guazi')
    if (vod.vod_id) guaziMetadata.set(vod.vod_id, raw)
    return vod
  }).filter((vod) => vod.vod_id && vod.vod_name && (!keyword || matchesFullSearchKeyword(vod.vod_name, keyword)))
    .slice(0, limit)
}

export async function searchCongcongSource(
  site: Site,
  keyword: string,
  limit: number,
  timeoutMs = 25_000,
  signal?: AbortSignal
): Promise<Vod[]> {
  if (site.nativeAdapter === 'jianpian' || site.key === 'jianpian') {
    return searchJianpianPage(site, keyword, 1, limit, '88', true, timeoutMs, signal)
  }

  const payload = await guaziRequest('/App/Index/findMoreVod', {
    keywords: keyword,
    order_val: '0',
    search_type: ''
  }, signal, timeoutMs)
  return mapGuaziList(payload, site, limit, keyword)
}

async function searchJianpianPage(
  site: Site,
  keyword: string,
  page: number,
  limit: number,
  categoryId = '88',
  filterKeyword = true,
  timeoutMs?: number,
  signal?: AbortSignal
): Promise<Vod[]> {
  const query = new URLSearchParams({
    key: keyword,
    category_id: categoryId,
    page: String(Math.max(1, page)),
    pageSize: String(Math.max(1, Math.min(100, Number.isFinite(limit) ? limit : 100)))
  })
  const payload = await fetchJianpianJson('/api/v2/search/videoV2', query, timeoutMs, signal)
  const nested = unwrap(payload, 'data', 'result', 'payload')
  const direct = firstArray(payload, 'data', 'items', 'list', 'vod_list')
  const raw = direct.length ? direct : firstArray(nested, 'items', 'list', 'vod_list', 'video_list')
  return raw
    .map((item) => makeVod(unwrap(item, 'work', 'vod'), site, 'jianpian'))
    .filter((vod) => vod.vod_id && vod.vod_name && (!filterKeyword || matchesFullSearchKeyword(vod.vod_name, keyword)))
}

export async function listCongcongSourceHome(
  site: Site,
  showId = GUAZI_HOME_SHOW_ID,
  limit = 24,
  pid = GUAZI_HOME_PID
): Promise<Vod[]> {
  if (site.nativeAdapter !== 'guazi' && site.key !== 'guazi') return []
  const payload = await guaziRequest('/App/IndexList/hotsList', {
    show_id: showId,
    pid
  })
  return mapGuaziList(payload, site, limit)
}

export async function listJianpianHome(
  site: Site,
  limit = 24,
  keyword = '热播',
  categoryId = '88'
): Promise<Vod[]> {
  if (site.nativeAdapter !== 'jianpian' && site.key !== 'jianpian') return []
  const query = keyword.trim() || '热播'
  try {
    return await searchJianpianPage(site, query, 1, limit, categoryId, false)
  } catch (error) {
    if (query === '热播') throw error
    return searchJianpianPage(site, '热播', 1, limit, categoryId, false)
  }
}

export async function testCongcongSource(site: Site): Promise<string> {
  if (site.nativeAdapter === 'jianpian' || site.key === 'jianpian') {
    const results = await searchCongcongSource(site, '流浪地球', 1)
    return results.length ? `荐片接口正常，已返回《${results[0].vod_name}》` : '荐片接口已响应，测试关键词暂无结果'
  }
  await guaziRequest('/App/Index/findMoreVod', { keywords: '测试', order_val: '0', search_type: '' })
  return '瓜子搜索接口已响应'
}

async function detailJianpian(site: Site, id: string): Promise<VodDetail> {
  const query = new URLSearchParams({ id })
  const outer = await fetchJianpianJson('/api/video/detailv2', query)
  const raw = unwrap(outer, 'data')
  const vod = makeVod(raw, site, 'jianpian')
  vod.vod_pic = resolveImageField(vod.vod_pic)
  return toDetail(vod, firstText(raw, 'description', 'synopsis', 'summary', 'content'), mapJianpianLines(raw))
}

function mergeGuaziMetadata(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  return {
    ...a,
    ...Object.fromEntries(Object.entries(b).filter(([, value]) =>
      value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '')
    ))
  }
}

function queryValues(value: string): URLSearchParams {
  return new URLSearchParams(value.replace(/^\?/, ''))
}

function chooseGuaziPlay(episode: Record<string, any>): URLSearchParams | null {
  const play = asObject(episode.play)
  for (const quality of ['720', '1080', '480']) {
    const param = firstText(asObject(play[quality]), 'param')
    if (!param) continue
    const query = queryValues(param)
    if (query.get('domain_type') && query.get('resolution')) {
      if (!query.get('type')) query.set('type', 'play')
      return query
    }
  }
  return null
}

async function detailGuazi(site: Site, id: string): Promise<VodDetail> {
  const detailResponse = await guaziRequest('/App/Resource/Vod/showOne', { d_id: id })
  const raw = unwrap(detailResponse, 'data', 'result', 'payload', 'vod', 'detail')
  const cached = guaziMetadata.get(id) ?? {}
  let metadata = mergeGuaziMetadata(cached, raw)
  let content = findGuaziContent(metadata)
  const lines: Line[] = []
  for (const cloudValue of firstArray(raw, 'vurl_clouds')) {
    const cloud = asObject(cloudValue)
    const cloudId = firstText(cloud, 'id')
    if (!cloudId) continue
    const episodesResponse = await guaziRequest('/App/Resource/Vurl/show', {
      vurl_cloud_id: cloudId,
      vod_d_id: id
    })
    const episodes = firstArray(unwrap(episodesResponse, 'data'), 'list')
    const mapped: Episode[] = []
    for (const episodeValue of episodes) {
      const episode = asObject(episodeValue)
      const episodeId = firstText(episode, 'id')
      const play = chooseGuaziPlay(episode)
      if (!episodeId || !play) continue
      const params = new URLSearchParams({
        vod_id: id,
        vurl_cloud_id: cloudId,
        vurl_id: episodeId,
        domain_type: play.get('domain_type') ?? '',
        resolution: play.get('resolution') ?? '',
        type: play.get('type') ?? 'play'
      })
      mapped.push({ name: firstText(episode, 'title', 'name') || `第${mapped.length + 1}集`, url: `ccguazi://play?${params}`, index: mapped.length })
    }
    if (mapped.length) lines.push({ name: firstText(cloud, 'name') || '瓜子线路', episodes: mapped })
  }
  try {
    const info = asObject(await guaziRequest('/App/IndexPlay/playInfo', {
      token_id: '',
      vod_id: id,
      mobile_time: String(Math.floor(Date.now() / 1000)),
      token: await getGuaziToken()
    }))
    const vodInfo = asObject(info.vodInfo)
    metadata = mergeGuaziMetadata(metadata, info)
    metadata = mergeGuaziMetadata(metadata, vodInfo)
    content = findGuaziContent(vodInfo) || findGuaziContent(metadata)
  } catch {
    // 播放信息接口失败时，仍保留 showOne 和搜索/首页缓存中的资料。
  }
  const vod = makeVod(metadata, site, 'guazi')
  if (!vod.vod_name) vod.vod_name = id
  return toDetail(vod, content, lines)
}

export async function getCongcongSourceDetail(site: Site, id: string): Promise<VodDetail> {
  if (site.nativeAdapter === 'jianpian' || site.key === 'jianpian') return detailJianpian(site, id)
  if (site.nativeAdapter === 'guazi' || site.key === 'guazi') return detailGuazi(site, id)
  throw new Error('未知的丛丛影视专用源')
}

function findPlayableUrl(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return ''
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    return value.startsWith('http') && (lower.includes('.m3u8') || lower.includes('.mp4') || lower.includes('.mpd')) ? value : ''
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPlayableUrl(item, depth + 1)
      if (found) return found
    }
    return ''
  }
  const object = asObject(value)
  for (const key of ['url', 'play_url', 'playUrl', 'm3u8', 'video_url', 'videoUrl', 'data', 'result']) {
    const found = findPlayableUrl(object[key], depth + 1)
    if (found) return found
  }
  for (const item of Object.values(object)) {
    const found = findPlayableUrl(item, depth + 1)
    if (found) return found
  }
  return ''
}

export async function resolveCongcongEpisode(siteKey: string, rawUrl: string, site?: Site): Promise<string> {
  if ((site?.nativeAdapter !== 'guazi' && siteKey !== 'guazi') || !rawUrl.startsWith('ccguazi://')) return rawUrl
  const url = new URL(rawUrl)
  const params = url.searchParams
  const result = await guaziRequest('/App/Resource/VurlDetail/showOne', {
    vod_id: params.get('vod_id') ?? '',
    domain_type: params.get('domain_type') ?? '',
    vurl_id: params.get('vurl_id') ?? '',
    resolution: params.get('resolution') ?? '',
    type: params.get('type') ?? 'play'
  })
  const mediaUrl = findPlayableUrl(result)
  if (!mediaUrl) throw new Error('瓜子播放接口没有返回媒体地址')
  return mediaUrl
}
