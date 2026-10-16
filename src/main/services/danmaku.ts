import type { DanmakuCandidate, DanmakuCue } from '@shared/types'
import * as cheerio from 'cheerio'
import { networkFetch } from './http'

const API_BASE = 'https://logvardanmu.konfan.cn/87654321'
const SEARCH_TIMEOUT_MS = 4500
const COMMENT_TIMEOUT_MS = 7000
const MAX_RETRIES = 0
const DANMAKU_CACHE_TTL_MS = 30 * 60 * 1000
const DANMAKU_CACHE_LIMIT = 256
const MAX_DANMAKU_CUES = 20000
const DANMAKU_SEARCH_CACHE_LIMIT = 64
const activeRequests = new Map<string, AbortController>()
const danmakuCache = new Map<string, { loadedAt: number; cues: DanmakuCue[] }>()
const danmakuSearchCache = new Map<string, { loadedAt: number; candidates: DanmakuCandidate[] }>()

interface EpisodeItem {
  id: string
  name: string
  series: string
  number: number
  season: number
  movie: boolean
}

interface AnimeItem {
  id: string
  name: string
}

interface RequestContext {
  key: string
  signal: AbortSignal
  abort: () => void
  release: () => void
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`弹幕服务 HTTP ${status}`)
  }
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function chineseNumber(value: string): number {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  let section = 0
  let digit = 0
  for (const character of value) {
    if (character in digits) {
      digit = digits[character]
    } else {
      const unit = character === '十' ? 10 : character === '百' ? 100 : character === '千' ? 1000 : 0
      if (!unit) return 0
      section += (digit || (unit === 10 && section === 0 ? 1 : 0)) * unit
      digit = 0
    }
  }
  return section + digit
}

function episodeNumber(value: string): number {
  const explicit = [
    /\bS\s*\d+\s*E\s*0*(\d+)\b/i,
    /\bEP(?:ISODE)?\s*0*(\d+)\b/i,
    /(?:第\s*\d+\s*季\s*)?第?\s*0*(\d+)\s*(?:集|话|回|期|話|화)/i,
    /^\s*0*(\d+)\s*$/
  ]
  for (const pattern of explicit) {
    const match = pattern.exec(value)
    if (match) return Number(match[1])
  }
  const chineseEpisode = /第\s*([零〇一二两三四五六七八九十百千]+)\s*(?:集|话|回|期|話)/.exec(value)
  if (chineseEpisode) return chineseNumber(chineseEpisode[1])

  const token = /(?:^|[\s._#\-/()[\]])0*(\d{1,3})(?=$|[\s._#\-/()[\]])/g
  let match: RegExpExecArray | null
  let lastEpisode = 0
  while ((match = token.exec(value))) {
    const start = match.index + match[0].indexOf(match[1])
    const end = start + match[1].length
    if ((start >= 2 && value[start - 1] === '.' && /\d/.test(value[start - 2])) ||
      (end + 1 < value.length && value[end] === '.' && /\d/.test(value[end + 1]))) continue
    const number = Number(match[1])
    if (number > 0 && (number < 1900 || number > 2099) && ![360, 480, 720, 1080, 1440].includes(number)) {
      lastEpisode = number
    }
  }
  return lastEpisode
}

function seasonNumber(value: string): number {
  const match = /\b(?:S|SEASON)\s*0*(\d+)(?:\s*E\s*0*\d+)?\b|第\s*0*(\d+)\s*季/i.exec(value)
  return Number(match?.[1] ?? match?.[2] ?? 0)
}

function beginRequest(requestId: string): RequestContext {
  const key = requestId.trim() || 'default'
  cancelDanmaku(key)
  const controller = new AbortController()
  activeRequests.set(key, controller)
  return {
    key,
    signal: controller.signal,
    abort: () => controller.abort(),
    release: () => {
      if (activeRequests.get(key) === controller) activeRequests.delete(key)
    }
  }
}

export function cancelDanmaku(requestId: string): void {
  const key = requestId.trim() || 'default'
  const controller = activeRequests.get(key)
  if (!controller) return
  activeRequests.delete(key)
  controller.abort()
}

function readDanmakuCache(id: string): DanmakuCue[] | undefined {
  const cached = danmakuCache.get(id)
  if (!cached) return undefined
  if (Date.now() - cached.loadedAt > DANMAKU_CACHE_TTL_MS) {
    danmakuCache.delete(id)
    return undefined
  }
  danmakuCache.delete(id)
  danmakuCache.set(id, cached)
  return cached.cues
}

function cacheDanmaku(id: string, cues: DanmakuCue[], sharedKey = ''): void {
  if (!cues.length) return
  const entry = { loadedAt: Date.now(), cues }
  for (const key of [`id:${id}`, sharedKey ? `episode:${sharedKey}` : '']) {
    if (!key) continue
    danmakuCache.delete(key)
    danmakuCache.set(key, entry)
  }
  while (danmakuCache.size > DANMAKU_CACHE_LIMIT) {
    const oldest = danmakuCache.keys().next().value
    if (oldest === undefined) break
    danmakuCache.delete(oldest)
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('弹幕请求已取消'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new Error('弹幕请求已取消'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function getJson(url: string, signal: AbortSignal, timeoutMs = SEARCH_TIMEOUT_MS): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) throw new Error('弹幕请求已取消')
    const request = new AbortController()
    const forwardAbort = (): void => request.abort()
    signal.addEventListener('abort', forwardAbort, { once: true })
    const timer = setTimeout(() => request.abort(), timeoutMs)
    try {
      const response = await networkFetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'CongcongTV/1.0' },
        signal: request.signal
      })
      if (!response.ok) {
        const error = new HttpError(response.status)
        if (response.status < 500 || attempt === MAX_RETRIES) throw error
        lastError = error
      } else {
        return await response.json()
      }
    } catch (error) {
      if (signal.aborted) throw new Error('弹幕请求已取消')
      if (error instanceof HttpError && error.status < 500) throw error
      lastError = error
      if (attempt === MAX_RETRIES) {
        if (request.signal.aborted) throw new Error('弹幕服务请求超时')
        throw error
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', forwardAbort)
    }
    await wait(250, signal)
  }
  throw lastError instanceof Error ? lastError : new Error('弹幕请求失败')
}

function isMovieType(value: Record<string, any>): boolean {
  const type = text(value.type ?? value.typeDescription ?? value.type_description ?? value.category ?? value.videoType).toLowerCase()
  return type === '电影' || type === 'movie' || type === 'film' || value.isMovie === true || value.movie === true
}

function collectEpisodes(root: unknown): EpisodeItem[] {
  const out: EpisodeItem[] = []
  const visit = (value: unknown, series = '', inheritedSeason = 0, inheritedMovie = false, depth = 0): void => {
    if (depth > 7 || !value) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, series, inheritedSeason, inheritedMovie, depth + 1)
      return
    }
    const item = object(value)
    const nextSeries = text(item.animeTitle ?? item.seriesTitle ?? item.anime_name)
      || (Array.isArray(item.episodes) ? text(item.title ?? item.name) : '')
      || series
    const nextSeason = seasonNumber(text(item.seasonNumber ?? item.season ?? item.seasonNo ?? item.season_num))
      || seasonNumber(nextSeries)
      || inheritedSeason
    const nextMovie = inheritedMovie || isMovieType(item)
    const id = text(item.episodeId ?? item.episode_id ?? item.id)
    const name = text(item.episodeTitle ?? item.episode_title ?? item.title ?? item.name)
    const hasEpisodeFields = item.episodeNumber !== undefined || item.number !== undefined ||
      item.episodeTitle !== undefined || item.episode_title !== undefined
    if (id && name && hasEpisodeFields) {
      const parsedNumber = Number(item.episodeNumber ?? item.number ?? item.sort)
      out.push({
        id,
        name,
        series: nextSeries,
        number: Number.isFinite(parsedNumber) && parsedNumber > 0 ? parsedNumber : episodeNumber(name),
        season: nextSeason || seasonNumber(name),
        movie: nextMovie
      })
    }
    for (const child of Object.values(item)) {
      if (Array.isArray(child) || (child && typeof child === 'object')) {
        visit(child, nextSeries, nextSeason, nextMovie, depth + 1)
      }
    }
  }
  visit(root)
  return out
}

function collectAnime(root: unknown): AnimeItem[] {
  const value = object(root)
  const candidates = [value, ...(Array.isArray(value.animes) ? value.animes : []),
    ...(Array.isArray(value.anime) ? value.anime : []), ...(Array.isArray(value.data) ? value.data : [])]
  if (Array.isArray(root)) candidates.push(...root.map(object))
  return candidates.flatMap((candidate) => {
    const item = object(candidate)
    const id = text(item.animeId ?? item.anime_id ?? item.id)
    const name = text(item.animeTitle ?? item.title ?? item.name ?? item.anime_name)
    return id && name ? [{ id, name }] : []
  }).filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function danmakuSearchKey(title: string, episode: string): string {
  const number = episodeNumber(episode)
  return `${normalize(title)}::${seasonNumber(episode)}::${number || normalize(episode)}`
}

function readDanmakuSearchCache(key: string): DanmakuCandidate[] | undefined {
  const cached = danmakuSearchCache.get(key)
  if (!cached) return undefined
  if (Date.now() - cached.loadedAt > DANMAKU_CACHE_TTL_MS) {
    danmakuSearchCache.delete(key)
    return undefined
  }
  danmakuSearchCache.delete(key)
  danmakuSearchCache.set(key, cached)
  return cached.candidates
}

function cacheDanmakuSearch(key: string, candidates: DanmakuCandidate[]): void {
  if (!candidates.length) return
  danmakuSearchCache.delete(key)
  danmakuSearchCache.set(key, { loadedAt: Date.now(), candidates })
  while (danmakuSearchCache.size > DANMAKU_SEARCH_CACHE_LIMIT) {
    const oldest = danmakuSearchCache.keys().next().value
    if (oldest === undefined) break
    danmakuSearchCache.delete(oldest)
  }
}

function rankEpisodes(title: string, episode: string, items: EpisodeItem[]): DanmakuCandidate[] {
  const normalizedTitle = normalize(title)
  const normalizedEpisode = normalize(episode)
  const requestedNumber = episodeNumber(episode)
  const requestedSeason = seasonNumber(episode)
  const ranked = items.flatMap((item) => {
    const itemNumber = item.number || episodeNumber(item.name)
    const series = normalize(item.series)
    const titleMatch = Boolean(normalizedTitle && series.includes(normalizedTitle))
    const exactTitleMatch = Boolean(normalizedTitle && series === normalizedTitle)
    const movieFragment = /(?:片段|预告|花絮|宣传片|trailer|preview|clip|\bpv\b)/i.test(item.name)
    let episodeScore = 0
    if (requestedNumber > 0) {
      if (itemNumber === requestedNumber) episodeScore = 100
      else if (item.movie && titleMatch && !movieFragment) episodeScore = 60
      else return []
    } else if (normalizedEpisode && normalize(item.name).includes(normalizedEpisode)) {
      episodeScore = 80
    } else if (item.movie && titleMatch && !movieFragment) {
      episodeScore = 60
    } else {
      return []
    }
    if (requestedSeason > 0 && item.season !== requestedSeason) return []

    const titleScore = !series ? 0 : series === normalizedTitle ? 20 : titleMatch ? 10 : -1
    if (titleScore < 0) return []
    return [{
      id: item.id,
      name: [item.series, item.name].filter(Boolean).join(' · ') || item.id,
      episodeTitle: item.name,
      score: episodeScore + titleScore,
      exactSeriesMatch: exactTitleMatch
    }]
  })
  const unique = new Map<string, (typeof ranked)[number]>()
  for (const candidate of ranked) {
    const existing = unique.get(candidate.id)
    if (!existing || candidate.score > existing.score) unique.set(candidate.id, candidate)
  }
  return [...unique.values()].sort((a, b) => b.score - a.score)
    .slice(0, 80)
    .map(({ score, ...candidate }) => ({ ...candidate, matchScore: score }))
}

function rankAnime(title: string, items: AnimeItem[]): AnimeItem[] {
  const normalizedTitle = normalize(title)
  return items.map((item) => {
    const name = normalize(item.name)
    const score = name === normalizedTitle ? 3
      : name.includes(normalizedTitle) || normalizedTitle.includes(name) ? 2 : 0
    return { item, score }
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ item }) => item)
}

function bilibiliTitle(value: unknown): string {
  return cheerio.load(String(value ?? ''))('body').text().replace(/\s+/g, ' ').trim()
}

async function searchBilibili(title: string, episode: string, request: RequestContext): Promise<DanmakuCandidate[]> {
  const number = episodeNumber(episode)
  const keyword = number ? `${title} 第${number}集` : title
  const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}`
  const payload = object(await getJson(url, request.signal, SEARCH_TIMEOUT_MS))
  const data = object(payload.data)
  const videoGroup = (Array.isArray(data.result) ? data.result : [])
    .map(object)
    .find((group) => group.result_type === 'video')
  const videos = Array.isArray(videoGroup?.data) ? videoGroup.data.map(object) : []
  const normalizedTitle = normalize(title)
  const matchingVideos = videos.flatMap((video) => {
    const name = bilibiliTitle(video.title)
    const normalizedName = normalize(name)
    if (!name || !normalizedName.includes(normalizedTitle) || !text(video.bvid)) return []
    const exactSeriesMatch = normalizedName.startsWith(normalizedTitle)
    return [{ bvid: text(video.bvid), name, exactSeriesMatch, rank: Number(video.rank_score) || 0 }]
  }).filter((video) => !/(?:解说|预告|花絮|reaction|影评|原声|音乐|吐槽|混剪|片段)/i.test(video.name)).slice(0, 20)
  const views = await Promise.all(matchingVideos.map(async (video) => {
    try {
      const view = object(await getJson(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(video.bvid)}`,
        request.signal,
        SEARCH_TIMEOUT_MS
      ))
      const info = object(view.data)
      const pages = Array.isArray(info.pages) ? info.pages.map(object) : []
      const count = Number(object(info.stat).danmaku) || 0
      const page = number
        ? pages.find((item) => episodeNumber(text(item.part)) === number)
          ?? (pages.length >= number ? pages[number - 1] : undefined)
        : pages[0]
      if (!page || !text(page.cid) || count <= 0 || (number > 1 && pages.length < number)) return []
      const episodicTitle = /(?:第\s*\d+\s*集|\d+\s*[-~至]\s*\d+\s*集|全集)/i.test(video.name)
      return [{
        id: `bili:${text(page.cid)}`,
        name: `${video.name} · ${text(page.part) || `P${page.page ?? 1}`}`,
        episodeTitle: text(page.part) || `P${page.page ?? 1}`,
        count,
        exactSeriesMatch: video.exactSeriesMatch,
        matchScore: (video.exactSeriesMatch ? 100 : 50) + (episodicTitle ? 30 : 0) + (number && pages.length >= number ? 10 : 0) + Math.log10(count + 1) + video.rank / 100000
      } satisfies DanmakuCandidate]
    } catch {
      return []
    }
  }))
  return views.flat().sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0)).slice(0, 8)
}

export async function searchDanmaku(title: string, episode: string, requestId = 'default'): Promise<DanmakuCandidate[]> {
  const anime = title.trim()
  if (!anime) return []
  const request = beginRequest(requestId)
  const number = episodeNumber(episode)
  const cacheKey = danmakuSearchKey(anime, episode)
  let lastError: unknown
  try {
    const cached = readDanmakuSearchCache(cacheKey)
    if (cached) return cached.map((candidate) => ({ ...candidate, cacheKey }))
    const primarySignal = AbortSignal.any([request.signal, AbortSignal.timeout(6500)])
    const queryEpisodes = async (includeNumber: boolean): Promise<DanmakuCandidate[]> => {
      const query = new URLSearchParams({ anime })
      if (includeNumber && number) query.set('episode', String(number))
      const payload = await getJson(`${API_BASE}/api/v2/search/episodes?${query}`, primarySignal)
      return rankEpisodes(anime, episode, collectEpisodes(payload))
    }

    const primarySearch = (async (): Promise<DanmakuCandidate[]> => {
      try {
        const first = await queryEpisodes(true)
        if (first.length || !number) return first
        const second = await queryEpisodes(false)
        if (second.length) return second
        const animePayload = await getJson(`${API_BASE}/api/v2/search/anime?keyword=${encodeURIComponent(anime)}`, primarySignal)
        for (const candidate of rankAnime(anime, collectAnime(animePayload))) {
          const bangumi = await getJson(`${API_BASE}/api/v2/bangumi/${encodeURIComponent(candidate.id)}`, primarySignal)
          const found = rankEpisodes(anime, episode, collectEpisodes(bangumi))
          if (found.length) return found
        }
        return []
      } catch (error) {
        lastError = error
        return []
      }
    })()
    const bilibiliSearch = searchBilibili(anime, episode, request).catch((error: unknown) => {
      if (!request.signal.aborted) lastError = error
      return []
    })
    const primaryCandidates = await primarySearch
    const bilibiliCandidates = primaryCandidates.length
      ? await Promise.race([
        bilibiliSearch,
        wait(350, request.signal).then(() => [] as DanmakuCandidate[]).catch(() => [] as DanmakuCandidate[])
      ])
      : await bilibiliSearch
    request.abort()
    const candidates = [...primaryCandidates.slice(0, 4), ...bilibiliCandidates.slice(0, 4)]
    if (candidates.length) {
      cacheDanmakuSearch(cacheKey, candidates)
      return candidates.map((candidate) => ({ ...candidate, cacheKey }))
    }
    if (lastError) throw lastError
    return []
  } finally {
    request.release()
  }
}

function normalizedColor(size: string, color: string | undefined): string {
  let rawColor = text(color)
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(rawColor)) return rawColor
  if (/^0x[0-9a-f]+$/i.test(rawColor)) rawColor = String(Number.parseInt(rawColor.slice(2), 16))
  if (!rawColor && /^(?:#|0x[0-9a-f]+|\d{4,})$/i.test(size)) rawColor = size
  if (!rawColor || !/^\d+$/.test(rawColor)) rawColor = '16777215'
  const numericColor = Number(rawColor)
  return `#${Math.max(0, Math.min(0xffffff, Number.isFinite(numericColor) ? numericColor : 0xffffff)).toString(16).padStart(6, '0')}`
}

function limitDanmakuAcrossTimeline(cues: DanmakuCue[]): DanmakuCue[] {
  if (cues.length <= MAX_DANMAKU_CUES) return cues

  const step = (cues.length - 1) / (MAX_DANMAKU_CUES - 1)
  return Array.from({ length: MAX_DANMAKU_CUES }, (_, index) => cues[Math.round(index * step)])
}

export async function loadDanmaku(id: string, requestId = 'default', sharedKey = ''): Promise<DanmakuCue[]> {
  if (!id.trim()) return []
  const request = beginRequest(requestId)
  try {
    const cached = readDanmakuCache(`id:${id}`)
      ?? (sharedKey ? readDanmakuCache(`episode:${sharedKey}`) : undefined)
    if (cached) return cached
    const isBilibili = id.startsWith('bili:')
    const payload = isBilibili ? null : object(await getJson(
      `${API_BASE}/api/v2/comment/${encodeURIComponent(id)}?format=json`,
      request.signal,
      COMMENT_TIMEOUT_MS
    ))
    let rows: unknown[]
    if (isBilibili) {
      const cid = id.slice('bili:'.length)
      const response = await networkFetch(`https://comment.bilibili.com/${encodeURIComponent(cid)}.xml`, {
        headers: { Accept: 'application/xml,text/xml,*/*', Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36' },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(COMMENT_TIMEOUT_MS)])
      })
      if (!response.ok) throw new Error(`B站弹幕 HTTP ${response.status}`)
      const xml = await response.text()
      const $ = cheerio.load(xml, { xmlMode: true })
      rows = $('d').toArray().map((element) => ({ p: $(element).attr('p') ?? '', m: $(element).text() }))
    } else {
      rows = Array.isArray(payload?.comments) ? payload.comments : Array.isArray(payload?.data) ? payload.data : []
    }
    if (request.signal.aborted) throw new Error('弹幕请求已取消')
    const cues = rows.flatMap((row: unknown, index: number): DanmakuCue[] => {
      const item = object(row)
      const params = text(item.p).split(',')
      const time = Number(params[0])
      const comment = text(item.m ?? item.text)
      if (!comment || !Number.isFinite(time) || time < 0) return []
      return [{
        id: `${id}-${index}`,
        text: comment,
        time,
        color: normalizedColor(params[2] ?? '', params[3]),
        type: Number(params[1]) || 1
      }]
    }).sort((a, b) => a.time - b.time)
    const timelineCues = limitDanmakuAcrossTimeline(cues)
    cacheDanmaku(id, timelineCues, sharedKey)
    return timelineCues
  } finally {
    request.release()
  }
}
