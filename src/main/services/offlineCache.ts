import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  createWriteStream
} from 'node:fs'
import { finished } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import type { DanmakuCue, OfflineTask, OfflineTaskInput } from '@shared/types'
import { networkFetch } from './http'
import { resolveEpisodeForPlayer, resolvePlaybackHeaders } from './playback'
import { prepareOfflineMediaUrl } from './mediaProxy'
import { purifyM3u8 } from './m3u8Purify'
import { cancelDanmaku, loadDanmaku, searchDanmaku } from './danmaku'
import { app } from '../../tauri/platform'

type StoredTask = OfflineTask
type DownloadResource = { line: number; url: string; kind: 'segment' | 'map' | 'key'; range?: string; duration?: number }

const active = new Map<string, AbortController>()
const running = new Map<string, Promise<void>>()
const tasks = new Map<string, StoredTask>()
let loaded = false

function cacheRoot(): string {
  return join(app.getPath('userData'), 'offline-videos')
}

function taskIndex(): string {
  return join(app.getPath('userData'), 'offline-tasks.json')
}

function taskDirectory(id: string): string {
  return join(cacheRoot(), id)
}

async function cachePoster(task: StoredTask, signal: AbortSignal): Promise<void> {
  if (!task.pic || task.posterFile) return
  const response = await networkFetch(task.pic, {
    headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  })
  if (!response.ok || !/^image\//i.test(response.headers.get('content-type') ?? '')) return
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) return
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].toLowerCase()
  const extension = mime === 'image/png' ? 'png'
    : mime === 'image/webp' ? 'webp'
      : mime === 'image/gif' ? 'gif' : 'jpg'
  const file = `poster.${extension}`
  mkdirSync(taskDirectory(task.id), { recursive: true })
  writeFileSync(join(taskDirectory(task.id), file), bytes)
  task.posterFile = file
  update(task)
}

async function cacheDanmaku(task: StoredTask, signal: AbortSignal): Promise<void> {
  if (task.danmakuFile) return
  const requestId = `offline-${task.id}`
  const cancel = (): void => cancelDanmaku(requestId)
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const candidates = await searchDanmaku(task.movieName, task.episodeName, requestId)
    for (const candidate of candidates.slice(0, 4)) {
      if (signal.aborted) return
      try {
        const cues = await loadDanmaku(candidate.id, requestId, candidate.cacheKey)
        if (!cues.length) continue
        const file = 'danmaku.json'
        mkdirSync(taskDirectory(task.id), { recursive: true })
        writeFileSync(join(taskDirectory(task.id), file), JSON.stringify(cues), 'utf8')
        task.danmakuFile = file
        task.danmakuCount = cues.length
        update(task)
        return
      } catch {
        if (signal.aborted) return
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancelDanmaku(requestId)
  }
}

async function cacheTaskAssets(task: StoredTask, signal: AbortSignal): Promise<void> {
  const results = await Promise.allSettled([
    cachePoster(task, signal),
    cacheDanmaku(task, signal)
  ])
  for (const result of results) {
    if (result.status === 'rejected' && !signal.aborted) {
      console.warn(`[offline-cache] 可选媒体资料下载失败 (${task.id}):`, result.reason)
    }
  }
}

function persist(): void {
  const index = taskIndex()
  mkdirSync(join(index, '..'), { recursive: true })
  const temp = `${index}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify([...tasks.values()], null, 2), 'utf8')
  try {
    renameSync(temp, index)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform !== 'win32' || !['EPERM', 'EEXIST', 'EBUSY'].includes(code ?? '')) throw error
    try {
      copyFileSync(temp, index)
    } catch (copyError) {
      console.warn('[offline-cache] 保存任务索引失败；下载仍将继续，后续更新会重试：', copyError)
    } finally {
      rmSync(temp, { force: true })
    }
  }
}

function initialize(): void {
  if (loaded) return
  loaded = true
  mkdirSync(cacheRoot(), { recursive: true })
  try {
    const parsed = JSON.parse(readFileSync(taskIndex(), 'utf8')) as StoredTask[]
    for (const task of parsed) {
      if (!task || typeof task.id !== 'string') continue
      if (!Number.isFinite(task.createdAt)) task.createdAt = task.updatedAt || Date.now()
      if (!Number.isFinite(task.estimatedTotalBytes)) task.estimatedTotalBytes = -1
      if (task.status === 'downloading' || task.status === 'queued') {
        task.status = 'paused'
        task.error = '应用关闭时任务已暂停，可继续下载'
      }
      tasks.set(task.id, task)
    }
  } catch {
    // 首次启动时还没有任务索引。
  }
  persist()
}

function update(task: StoredTask, persistNow = true): void {
  task.updatedAt = Date.now()
  tasks.set(task.id, task)
  if (persistNow) persist()
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function safeExtension(url: string, contentType = ''): string {
  const suffix = extname(new URL(url).pathname).toLowerCase()
  if (/^\.(mp4|mkv|webm|mov|avi|m4v|mp3|m4a|ts|flv)$/.test(suffix)) return suffix
  if (/webm/i.test(contentType)) return '.webm'
  if (/matroska/i.test(contentType)) return '.mkv'
  if (/audio\//i.test(contentType)) return '.m4a'
  return '.mp4'
}

function isHlsUrl(url: string): boolean {
  return /\.m3u8(?:$|[?#])/i.test(url) || /\/hls\//i.test(new URL(url).pathname)
}

function responseError(response: Response): Error {
  return new Error(`下载失败：HTTP ${response.status} ${response.statusText}`)
}

async function fetchPlaylist(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<{ text: string; url: string }> {
  const response = await networkFetch(url, { headers, signal, redirect: 'follow' })
  if (!response.ok) throw responseError(response)
  const text = await response.text()
  if (text.length > 8 * 1024 * 1024) throw new Error('HLS 播放列表超过 8 MB，无法离线缓存')
  return { text, url: response.url || url }
}

function selectVariant(url: string, playlist: string): { url: string; text: string; bandwidth: number } | null {
  const lines = playlist.split(/\r?\n/)
  let selected = ''
  let bandwidth = -1
  let estimatedBandwidth = 0
  for (let i = 0; i < lines.length; i++) {
    const info = lines[i]
    const match = info.match(/^#EXT-X-STREAM-INF:.*?BANDWIDTH=(\d+)/i)
    if (!match) continue
    const uri = lines.slice(i + 1).find((line) => line.trim() && !line.trim().startsWith('#'))?.trim()
    if (!uri) continue
    const value = Number(match[1]) || 0
    if (value > bandwidth) {
      bandwidth = value
      estimatedBandwidth = Number(info.match(/AVERAGE-BANDWIDTH=(\d+)/i)?.[1]) || value
      selected = new URL(uri, url).href
    }
  }
  return selected ? { url: selected, text: '', bandwidth: estimatedBandwidth } : null
}

function parseRange(value: string, fallbackStart: number): { header: string; next: number } {
  const match = value.match(/^(\d+)(?:@(\d+))?$/)
  if (!match) throw new Error(`无法处理 HLS 字节范围：${value}`)
  const length = Number(match[1])
  const start = match[2] ? Number(match[2]) : fallbackStart
  return { header: `bytes=${start}-${start + length - 1}`, next: start + length }
}

function rangeBounds(value: string): { start: number; end: number } | null {
  const match = value.match(/^bytes=(\d+)-(\d+)$/)
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null
}

function resourceExtension(url: string, kind: DownloadResource['kind']): string {
  if (kind === 'key') return 'key'
  const suffix = extname(new URL(url).pathname).slice(1).toLowerCase()
  return /^(ts|m4s|mp4|aac|m4a|vtt)$/.test(suffix) ? suffix : 'bin'
}

async function streamResponseToFile(
  response: Response,
  path: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  onBytes: (size: number) => void,
  append = false
): Promise<void> {
  if (!response.ok) throw responseError(response)
  if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error('资源返回了网页而不是媒体文件')
  }
  if (!response.body) throw new Error('服务器没有返回媒体内容')
  const output = createWriteStream(path, { flags: append ? 'a' : 'w' })
  const completed = finished(output)
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (signal.aborted) throw new Error('下载已停止')
      const data = Buffer.from(chunk)
      if (!output.write(data)) await new Promise<void>((resolve, reject) => {
        output.once('drain', resolve)
        output.once('error', reject)
      })
      onBytes(data.length)
    }
    output.end()
    await completed
  } catch (error) {
    output.destroy()
    await completed.catch(() => undefined)
    throw error
  }
  void headers
}

async function downloadDirect(
  task: StoredTask,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<string> {
  const directory = taskDirectory(task.id)
  mkdirSync(directory, { recursive: true })
  const existingFile = task.mediaFile && existsSync(join(directory, task.mediaFile))
    ? join(directory, task.mediaFile)
    : ''
  const fileName = existingFile ? task.mediaFile : `video${safeExtension(url)}`
  const target = join(directory, fileName)
  task.estimatedTotalBytes = -1
  const part = `${target}.part`
  const existing = existsSync(part) ? statSync(part).size : 0
  const requestHeaders = { ...headers }
  if (existing) requestHeaders.Range = `bytes=${existing}-`
  const response = await networkFetch(url, { headers: requestHeaders, signal, redirect: 'follow' })
  if (!response.ok) throw responseError(response)
  if (response.status === 206) {
    const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i)
    const expectedStart = existing > 0 ? existing : 0
    const total = range?.[3] === '*' ? null : Number(range?.[3])
    const incomplete = total !== null && Number.isFinite(total) && Number(range?.[2]) + 1 !== total
    if (!requestHeaders.Range || !range || Number(range[1]) !== expectedStart || incomplete) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('服务器返回的文件范围不匹配，已停止缓存以防文件损坏')
    }
  }
  const append = existing > 0 && response.status === 206
  if (existing > 0 && !append) rmSync(part, { force: true })
  const contentRange = response.headers.get('content-range')?.match(/\/(\d+)$/)
  const length = Number(response.headers.get('content-length')) || 0
  task.totalBytes = contentRange ? Number(contentRange[1]) : append ? existing + length : length
  task.downloadedBytes = append ? existing : 0
  update(task)
  await streamResponseToFile(
    response,
    part,
    requestHeaders,
    signal,
    (bytes) => {
      task.downloadedBytes += bytes
      task.progress = task.totalBytes > 0 ? Math.min(99, Math.floor(task.downloadedBytes * 100 / task.totalBytes)) : 0
      update(task, false)
    },
    append
  )
  renameSync(part, target)
  task.mediaFile = fileName
  task.totalBytes = statSync(target).size
  task.downloadedBytes = task.totalBytes
  return fileName
}

async function downloadHls(
  task: StoredTask,
  initialUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  purify: boolean
): Promise<string> {
  let bandwidth = 0
  let { text, url } = await fetchPlaylist(initialUrl, headers, signal)
  if (purify) text = purifyM3u8(url, text)
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variant = selectVariant(url, text)
    if (!variant) throw new Error('主播放列表没有可用的清晰度线路')
    bandwidth = variant.bandwidth
    const loadedVariant = await fetchPlaylist(variant.url, headers, signal)
    text = purify ? purifyM3u8(loadedVariant.url, loadedVariant.text) : loadedVariant.text
    url = loadedVariant.url
  }
  const upper = text.toUpperCase()
  if (!upper.includes('#EXT-X-ENDLIST') || /#EXT-X-PLAYLIST-TYPE:(?:EVENT|LIVE)|#EXT-X-PART:|#EXT-X-PRELOAD-HINT|#EXT-X-SERVER-CONTROL/.test(upper)) {
    throw new Error('仅支持已结束的 HLS 点播流离线缓存')
  }
  if (upper.includes('#EXT-X-I-FRAMES-ONLY')) throw new Error('该 HLS 是预览流，无法离线缓存')

  const lines = text.split(/\r?\n/)
  const resources: DownloadResource[] = []
  const replacements = new Map<number, string>()
  const implicitOffsets = new Map<string, number>()
  let pendingRange = ''
  let pendingDuration = 0
  let segmentCount = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    const extinf = line.match(/^#EXTINF:([\d.]+)/i)
    if (extinf) {
      pendingDuration = Number(extinf[1]) || 0
      continue
    }
    if (/^#EXT-X-BYTERANGE:/i.test(line)) {
      pendingRange = line.slice(line.indexOf(':') + 1)
      continue
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const method = line.match(/METHOD=([^,]+)/i)?.[1]?.toUpperCase()
      if (method && method !== 'AES-128' && method !== 'NONE') {
        throw new Error(`该 HLS 使用 ${method} 加密，无法安全离线缓存`)
      }
    }
    if (line.startsWith('#EXT-X-MAP:') || line.startsWith('#EXT-X-KEY:')) {
      const match = line.match(/URI="([^"]+)"/i)
      if (!match || /^(?:data|skd):/i.test(match[1])) continue
      const kind = line.startsWith('#EXT-X-MAP:') ? 'map' : 'key'
      let range: string | undefined
      const byterange = line.match(/BYTERANGE="([^"]+)"/i)?.[1]
      if (byterange) {
        const parsed = parseRange(byterange, implicitOffsets.get(match[1]) ?? 0)
        range = parsed.header
        implicitOffsets.set(match[1], parsed.next)
      }
      resources.push({ line: index, url: new URL(match[1], url).href, kind, range })
      continue
    }
    if (!line || line.startsWith('#')) continue
    const mediaUrl = new URL(line, url).href
    let range: string | undefined
    if (pendingRange) {
      const parsed = parseRange(pendingRange, implicitOffsets.get(mediaUrl) ?? 0)
      range = parsed.header
      implicitOffsets.set(mediaUrl, parsed.next)
      pendingRange = ''
    }
    resources.push({ line: index, url: mediaUrl, kind: 'segment', range, duration: pendingDuration })
    pendingDuration = 0
    segmentCount++
  }
  if (!segmentCount) throw new Error('HLS 播放列表中没有可缓存的媒体分片')

  const directory = taskDirectory(task.id)
  mkdirSync(directory, { recursive: true })
  const resourceNames = new Map<string, string>()
  const entries = resources.map((resource) => {
    const identity = `${resource.kind}|${resource.url}|${resource.range ?? ''}`
    const name = `${resource.kind}-${digest(identity)}.${resourceExtension(resource.url, resource.kind)}`
    resourceNames.set(identity, name)
    return { resource, identity, name }
  })
  const unique = [...new Map(entries.map((item) => [item.identity, item])).values()]
  const mediaDuration = unique.reduce(
    (total, item) => total + (item.resource.kind === 'segment' ? item.resource.duration ?? 0 : 0),
    0
  )
  task.estimatedTotalBytes = bandwidth > 0 && mediaDuration > 0 ? Math.ceil(mediaDuration * bandwidth / 8) : -1
  let completeCount = 0
  let sampledSegmentBytes = 0
  let sampledSegmentSeconds = 0
  let auxiliaryBytes = 0
  task.totalBytes = -1
  task.downloadedBytes = 0
  for (const item of unique) {
    const target = join(directory, item.name)
    const part = `${target}.part`
    if (existsSync(target)) {
      const size = statSync(target).size
      task.downloadedBytes += size
      completeCount++
      if (item.resource.kind === 'segment') {
        sampledSegmentBytes += size
        sampledSegmentSeconds += item.resource.duration ?? 0
      } else {
        auxiliaryBytes += size
      }
    } else if (existsSync(part)) {
      task.downloadedBytes += statSync(part).size
    }
  }
  const updateHlsProgress = (): void => {
    const sampleThreshold = Math.min(10, mediaDuration * 0.1)
    if (sampledSegmentSeconds >= sampleThreshold && sampledSegmentSeconds > 0 && mediaDuration > 0) {
      task.estimatedTotalBytes = Math.max(
        task.downloadedBytes,
        Math.ceil((sampledSegmentBytes / sampledSegmentSeconds) * mediaDuration) + auxiliaryBytes
      )
    }
    const estimated = task.estimatedTotalBytes ?? -1
    const candidate = estimated > 0
      ? Math.floor(task.downloadedBytes * 100 / estimated)
      : Math.floor(completeCount * 100 / Math.max(1, unique.length))
    task.progress = Math.max(task.progress, Math.min(95, candidate))
  }
  updateHlsProgress()
  const worker = async (item: (typeof unique)[number]): Promise<void> => {
    const target = join(directory, item.name)
    if (existsSync(target)) return
    const part = `${target}.part`
    let existing = existsSync(part) ? statSync(part).size : 0
    const bounds = item.resource.range ? rangeBounds(item.resource.range) : null
    if (bounds && existing === bounds.end - bounds.start + 1) {
      renameSync(part, target)
      completeCount++
      if (item.resource.kind === 'segment') {
        sampledSegmentBytes += existing
        sampledSegmentSeconds += item.resource.duration ?? 0
      } else {
        auxiliaryBytes += existing
      }
      updateHlsProgress()
      update(task, false)
      return
    }
    if (bounds && existing > bounds.end - bounds.start + 1) {
      rmSync(part, { force: true })
      task.downloadedBytes -= existing
      existing = 0
    }

    const requestHeaders = { ...headers }
    if (bounds) {
      if (existing) requestHeaders.Range = `bytes=${bounds.start + existing}-${bounds.end}`
      else requestHeaders.Range = item.resource.range!
    } else if (existing) {
      requestHeaders.Range = `bytes=${existing}-`
    }
    const response = await networkFetch(item.resource.url, { headers: requestHeaders, signal, redirect: 'follow' })
    if (!response.ok) throw responseError(response)
    const requested = requestHeaders.Range
    let append = existing > 0 && response.status === 206
    if (requested && response.status !== 206 && bounds) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('服务器未按字节范围返回 HLS 分片，无法安全续传')
    }
    if (response.status === 206) {
      const expectedStart = requested ? Number(requested.match(/^bytes=(\d+)-/)?.[1]) : undefined
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i)
      const expectedEnd = bounds?.end
      const total = range?.[3] === '*' ? null : Number(range?.[3])
      const incomplete = total !== null && Number.isFinite(total) && Number(range?.[2]) + 1 !== total
      if (expectedStart === undefined || !Number.isFinite(expectedStart) || !range || Number(range[1]) !== expectedStart ||
        (expectedEnd !== undefined ? Number(range[2]) !== expectedEnd : incomplete)) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('服务器返回的分片范围不匹配，已停止缓存以防文件损坏')
      }
    }
    if (existing > 0 && !append) {
      rmSync(part, { force: true })
      task.downloadedBytes = Math.max(0, task.downloadedBytes - existing)
      existing = 0
    }
    await streamResponseToFile(response, part, requestHeaders, signal, (bytes) => {
      task.downloadedBytes += bytes
      updateHlsProgress()
      update(task, false)
    }, append)
    renameSync(part, target)
    completeCount++
    const size = statSync(target).size
    if (item.resource.kind === 'segment') {
      sampledSegmentBytes += size
      sampledSegmentSeconds += item.resource.duration ?? 0
    } else {
      auxiliaryBytes += size
    }
    updateHlsProgress()
    update(task, false)
  }
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (cursor < unique.length) {
      const item = unique[cursor++]
      await worker(item)
    }
  }))

  const output = lines.map((line, index) => {
    if (/^\s*#EXT-X-BYTERANGE:/i.test(line)) return ''
    const item = entries.find((entry) => entry.resource.line === index)
    if (!item) return line
    if (item.resource.kind === 'segment') return item.name
    return line
      .replace(/URI="[^"]+"/i, `URI="${item.name}"`)
      .replace(/,?BYTERANGE="[^"]+"/i, '')
  }).join('\n')
  const manifest = join(directory, 'playlist.m3u8')
  writeFileSync(`${manifest}.part`, output, 'utf8')
  renameSync(`${manifest}.part`, manifest)
  task.totalBytes = task.downloadedBytes
  task.estimatedTotalBytes = -1
  task.progress = 100
  return 'playlist.m3u8'
}

function startWorker(task: StoredTask): void {
  if (active.has(task.id)) return
  const controller = new AbortController()
  active.set(task.id, controller)
  task.status = 'queued'
  task.error = ''
  update(task)
  const job = (async () => {
    const heartbeat = setInterval(() => persist(), 1000)
    const assetJob = cacheTaskAssets(task, controller.signal)
    try {
      task.status = 'downloading'
      update(task)
      const resolved = await resolveEpisodeForPlayer(task.siteKey, task.rawUrl)
      const headers = await resolvePlaybackHeaders(task.siteKey, resolved.sourceUrl)
      task.mediaFile = isHlsUrl(resolved.sourceUrl)
        ? await downloadHls(task, resolved.sourceUrl, headers, controller.signal, resolved.purifyEnabled)
        : await downloadDirect(task, resolved.sourceUrl, headers, controller.signal)
      await assetJob
      if (controller.signal.aborted) return
      task.status = 'completed'
      task.progress = 100
      task.error = ''
      task.downloadedBytes = task.totalBytes || task.downloadedBytes
      update(task)
    } catch (error) {
      if (task.status !== 'paused' && task.status !== 'cancelled') {
        task.status = controller.signal.aborted ? 'paused' : 'failed'
        task.error = controller.signal.aborted ? '下载已暂停，可继续' : (error as Error).message
      }
      update(task)
    } finally {
      clearInterval(heartbeat)
      active.delete(task.id)
      persist()
    }
  })()
  running.set(task.id, job)
  void job.finally(() => running.delete(task.id))
}

export function listOfflineTasks(): OfflineTask[] {
  initialize()
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export async function addOfflineTask(input: OfflineTaskInput): Promise<OfflineTask> {
  initialize()
  if (!input.rawUrl.trim()) throw new Error('当前剧集没有可缓存的播放地址')
  const id = digest(`${input.siteKey}|${input.vodId}|${input.episodeIndex}`)
  let task = tasks.get(id)
  if (task?.status === 'completed' && existsSync(join(taskDirectory(id), task.mediaFile))) {
    Object.assign(task, input)
    if (!task.posterFile || !task.danmakuFile) void cacheTaskAssets(task, new AbortController().signal)
    return task
  }
  if (task && active.has(id)) return task
  if (!task) {
    task = {
      id,
      createdAt: Date.now(),
      ...input,
      mediaFile: '',
      status: 'queued',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: -1,
      estimatedTotalBytes: -1,
      error: '',
      updatedAt: Date.now()
    }
    tasks.set(id, task)
  } else {
    Object.assign(task, input)
  }
  startWorker(task)
  return task
}

export async function pauseOfflineTask(id: string): Promise<void> {
  initialize()
  const task = tasks.get(id)
  if (!task || !active.has(id)) return
  task.status = 'paused'
  task.error = '下载已暂停，可继续'
  update(task)
  active.get(id)?.abort()
}

export async function retryOfflineTask(id: string): Promise<void> {
  initialize()
  const task = tasks.get(id)
  if (!task || task.status === 'completed') return
  if (active.has(id)) return
  startWorker(task)
}

export async function cancelOfflineTask(id: string): Promise<void> {
  initialize()
  const task = tasks.get(id)
  if (!task) return
  if (active.has(id)) {
    task.status = 'cancelled'
    task.error = '已取消'
    active.get(id)?.abort()
    await running.get(id)
  }
  rmSync(taskDirectory(id), { recursive: true, force: true })
  task.mediaFile = ''
  task.progress = 0
  task.downloadedBytes = 0
  task.totalBytes = -1
  task.status = 'cancelled'
  task.error = '已取消'
  update(task)
}

export async function deleteOfflineTask(id: string): Promise<void> {
  initialize()
  if (active.has(id)) await cancelOfflineTask(id)
  rmSync(taskDirectory(id), { recursive: true, force: true })
  tasks.delete(id)
  persist()
}

export async function getOfflinePlayback(id: string): Promise<{
  task: OfflineTask
  url: string
  posterUrl?: string
  danmaku: DanmakuCue[]
}> {
  initialize()
  const task = tasks.get(id)
  if (!task || task.status !== 'completed' || !task.mediaFile) throw new Error('这集尚未完成离线缓存')
  if (!existsSync(join(taskDirectory(id), task.mediaFile))) throw new Error('离线文件不存在，请重新缓存')
  let danmaku: DanmakuCue[] = []
  if (task.danmakuFile) {
    try {
      danmaku = JSON.parse(readFileSync(join(taskDirectory(id), task.danmakuFile), 'utf8')) as DanmakuCue[]
      if (!Array.isArray(danmaku)) danmaku = []
    } catch {
      danmaku = []
    }
  }
  return {
    task,
    url: await prepareOfflineMediaUrl(id, task.mediaFile),
    posterUrl: task.posterFile ? await prepareOfflineMediaUrl(id, task.posterFile) : undefined,
    danmaku
  }
}
