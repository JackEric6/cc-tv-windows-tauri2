import { createReadStream, createWriteStream } from 'node:fs'
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import { networkFetch } from './http'
import { decryptSensitiveCompressedJson } from './sensitiveData'

const REPOSITORY = 'JackEric6/cc-tv-windows-tauri2'
const RELEASE_ASSET_SUFFIX = '-release'
const GITHUB_ACCEL_PREFIXES = decryptSensitiveCompressedJson<string[]>(
  'tGmshSBQ/Naoqdri7zPgfDnZPKgfjcKg32DlL/p0C6AbbJbV40CnRxR0+vKBg1n1Vras1C5Zl5gd4h0L0Qj7+3D4PzdFkLDxjquIzxJ+cn7y0qXYnrwVY7YUe5yQaDcslIiq9ya6e0K91G0pXb5b6vrBjt614anvWucxSB7JVbHgImmxhdaWZ2EVU960GIuGatvK4WejBZ72CTea5Ekm0ILzEFMF0pzrv5zMrE59WSP1jA06mwu8IanmDtKSYuo/vrmQlgRSOeW6n3/r+yWbeM0f/+lVEMCe//F6iP/0yxqWySj1f4Nt2ytZxAt1QSZdXBOaYYqRYeK15PhdSLgubjLSAnKya7SHaMW/7lm0KB1l2MqJQT1wHJ47HfBx0dH+mwPufpciIIgt0mg97d0S9qdzLx1x+vRsyrJVF3UdlNJ7UUQl/SXxOtctIID4YOg8cMMLCb1fchmpj7uB5QaEqyzcAdhLcfztlmvpNCtk14DAUZNpFmUYOqKyHz2PYdZx3JIvCx38n7aiZf66sqhyYLc2HtjIUsM5D6SnW+Up8EMdoPDMRxfIqHccEsqxcSfnV5XW6WO/Kh8SvzPXdu4agU+LMZWcbyLSAbrXuHsFPxI2vmqH7S/EhyJz1uRkKPIjiAalQfNxeOHzYqnra9SgUHD9BQX/1JraEuheOLRI7DKVvIAOVKoDJttlBbSNTzMQes1Fwo6hxYyNPplswXuOcz4XsnwZx6YkERDWyAL2S6XM2e7+eJ5y/hyGF3aTapVCnShBr6eYNdQGO4+9PtecfNsCCcYyysisJbAPrEGkuLzkwgz1Rlk4iKry5Br/lpaOFhOnl3xD4ck2hFhgt+KofERT0ADNegdTjAEfzfUYB4lqKoVjaOwPCeM+tG/j42ZNC4TsQ61Ae3pLgfm1fhn85xgSRbQFlhKl/gU='
)
const GITHUB_API_PROBE_LIMIT = 12
const GITHUB_DOWNLOAD_PROBE_LIMIT = 56
const GITHUB_DOWNLOAD_PROBE_CONCURRENCY = 10
const GITHUB_DOWNLOAD_PROBE_SAMPLE_BYTES = 64 * 1024
const GITHUB_DOWNLOAD_PROBE_WINDOW_MS = 1000
const GITHUB_DOWNLOAD_FINALIST_COUNT = 3
const GITHUB_DOWNLOAD_FINAL_SAMPLE_BYTES = 512 * 1024
const GITHUB_DOWNLOAD_FINAL_WINDOW_MS = 1200
const GITHUB_DOWNLOAD_MIN_SAMPLE_BYTES = 64 * 1024
const GITHUB_DOWNLOAD_FAST_START_BYTES_PER_SECOND = 1 * 1024 * 1024
const ORIGINAL_LINK_PROBE_TIMEOUT_MS = 2000
const GITHUB_API_REQUEST_TIMEOUT_MS = 5000
const DOWNLOAD_RANGE_CHUNK_BYTES = 1024 * 1024
const DOWNLOAD_RANGE_CONCURRENCY = 4
const DOWNLOAD_RANGE_TIMEOUT_MS = 10 * 60_000
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
const DOWNLOAD_ROUTE_ATTEMPT_TIMEOUT_MS = 20_000
const MAX_INSTALLER_BYTES = 120 * 1024 * 1024

interface GitHubRelease {
  tag_name?: unknown
  body?: unknown
  assets?: Array<{ name?: unknown; size?: unknown; digest?: unknown; content_type?: unknown; browser_download_url?: unknown }>
}

interface LatestReleaseInfo {
  currentVersion: string
  latestVersion: string
  notes: string
  assetName: string
  assetSize: number
  downloadUrl: string
  digest: string
}

let cachedLatestRelease: LatestReleaseInfo | undefined
let cachedLatestReleaseAt = 0

function versionParts(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
  return match ? match.slice(1).map(Number) : null
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

interface ReleaseDownloadRoute {
  url: string
  bytesPerSecond: number
  rangeSupported: boolean
  sampleBytes: number
}

function createDownloadTimeout(parent?: AbortSignal): {
  signal: AbortSignal
  touch: () => void
  close: () => void
} {
  const controller = new AbortController()
  const abortFromParent = (): void => controller.abort(parent?.reason)
  if (parent?.aborted) abortFromParent()
  else parent?.addEventListener('abort', abortFromParent, { once: true })

  const maxTimer = setTimeout(() => controller.abort(new Error('下载链路总耗时超限')), DOWNLOAD_RANGE_TIMEOUT_MS)
  let idleTimer: NodeJS.Timeout
  const touch = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(new Error('下载链路 30 秒没有数据')), DOWNLOAD_IDLE_TIMEOUT_MS)
  }
  touch()

  return {
    signal: controller.signal,
    touch,
    close: () => {
      clearTimeout(maxTimer)
      clearTimeout(idleTimer)
      parent?.removeEventListener('abort', abortFromParent)
    }
  }
}

async function probeReleaseUrl(
  url: string,
  timeoutMs: number,
  expectedSize: number,
  sampleBytes: number,
  signal?: AbortSignal
): Promise<ReleaseDownloadRoute> {
  const started = performance.now()
  const response = await networkFetch(url, {
    headers: { Range: `bytes=0-${sampleBytes - 1}`, 'Accept-Encoding': 'identity' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`HTTP ${response.status}`)
  }

  const rangeSupported = response.status === 206
  let requestedBytes = sampleBytes
  if (rangeSupported) {
    const range = /^bytes\s+0-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
    if (!range || Number(range[2]) !== expectedSize) {
      await response.body.cancel().catch(() => undefined)
      throw new Error('Range 响应格式无效')
    }
    requestedBytes = Math.min(requestedBytes, Number(range[1]) + 1)
  } else if (response.status !== 200) {
    await response.body.cancel().catch(() => undefined)
    throw new Error(`不支持的 HTTP 状态：${response.status}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (/^(text\/html|application\/(?:json|problem\+json))/i.test(contentType)) {
    await response.body.cancel().catch(() => undefined)
    throw new Error('测速链路返回了错误页面')
  }

  const reader = response.body.getReader()
  let received = 0
  let firstByteAt = 0
  try {
    while (received < requestedBytes) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!firstByteAt) firstByteAt = performance.now()
      received += chunk.value?.byteLength ?? 0
    }
    if (received === 0) throw new Error('测速链路没有返回数据')
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const elapsedAfterFirstByte = Math.max(1, performance.now() - (firstByteAt || started))
  return { url, bytesPerSecond: received * 1000 / elapsedAfterFirstByte, rangeSupported, sampleBytes: received }
}

async function fastestReleaseDownloadRoutes(originalUrl: string, expectedSize: number): Promise<ReleaseDownloadRoute[]> {
  const routes = [
    ...GITHUB_ACCEL_PREFIXES.map((prefix) => `${prefix}${originalUrl}`),
    originalUrl
  ]
  const testedRoutes = [
    routes[routes.length - 1],
    ...routes.slice(0, GITHUB_DOWNLOAD_PROBE_LIMIT)
  ]
  const probeBatch = async (
    urls: string[],
    bytes: number,
    windowMs: number
  ): Promise<{ samples: ReleaseDownloadRoute[]; fastRoute?: ReleaseDownloadRoute }> => {
    const controller = new AbortController()
    const samples: Array<ReleaseDownloadRoute | undefined> = new Array(urls.length)
    let fastRoute: ReleaseDownloadRoute | undefined
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < urls.length && !controller.signal.aborted) {
        const index = cursor++
        try {
          const sample = await probeReleaseUrl(
            urls[index],
            urls[index] === routes[routes.length - 1]
              ? ORIGINAL_LINK_PROBE_TIMEOUT_MS
              : windowMs + 300,
            expectedSize,
            bytes,
            controller.signal
          )
          samples[index] = sample
          if (sample.sampleBytes >= GITHUB_DOWNLOAD_MIN_SAMPLE_BYTES &&
            sample.bytesPerSecond >= GITHUB_DOWNLOAD_FAST_START_BYTES_PER_SECOND) {
            fastRoute = sample
            controller.abort(new Error('已找到超过 1 MB/s 的下载线路'))
          }
        } catch {
          samples[index] = undefined
        }
      }
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(Array.from(
        { length: Math.min(GITHUB_DOWNLOAD_PROBE_CONCURRENCY, urls.length) },
        () => worker()
      )),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort()
          resolve()
        }, windowMs + 800)
      })
    ])
    if (timeout) clearTimeout(timeout)
    controller.abort()
    return { samples: samples.flatMap((sample) => sample ? [sample] : []), fastRoute }
  }

  const smallBatch = await probeBatch(testedRoutes, GITHUB_DOWNLOAD_PROBE_SAMPLE_BYTES, GITHUB_DOWNLOAD_PROBE_WINDOW_MS)
  if (smallBatch.fastRoute) {
    const route = smallBatch.fastRoute
    return [
      route,
      ...routes.filter((url) => url !== route.url).map((url) => ({
        url,
        bytesPerSecond: 0,
        rangeSupported: false,
        sampleBytes: 0
      }))
    ]
  }
  const small = smallBatch.samples
  const alive = small
    .filter((route) => route.sampleBytes >= GITHUB_DOWNLOAD_MIN_SAMPLE_BYTES)
    .sort((left, right) => right.bytesPerSecond - left.bytesPerSecond)
  if (!alive.length) {
    return routes.map((url) => ({ url, bytesPerSecond: 0, rangeSupported: false, sampleBytes: 0 }))
  }

  const finalists = alive.slice(0, GITHUB_DOWNLOAD_FINALIST_COUNT)
  const finalBatch = await probeBatch(
    finalists.map((route) => route.url),
    GITHUB_DOWNLOAD_FINAL_SAMPLE_BYTES,
    GITHUB_DOWNLOAD_FINAL_WINDOW_MS
  )
  if (finalBatch.fastRoute) {
    const route = finalBatch.fastRoute
    return [
      route,
      ...routes.filter((url) => url !== route.url).map((url) => ({
        url,
        bytesPerSecond: 0,
        rangeSupported: false,
        sampleBytes: 0
      }))
    ]
  }
  const finalSamples = finalBatch.samples
  const finalAlive = finalSamples.filter((route) => route.sampleBytes >= GITHUB_DOWNLOAD_MIN_SAMPLE_BYTES)
    .sort((left, right) => right.bytesPerSecond - left.bytesPerSecond)
  const rankedTested = [
    ...finalAlive,
    ...alive.filter((route) => !finalists.some((finalist) => finalist.url === route.url))
  ]
  const rankedUrls = new Set(rankedTested.map((route) => route.url))
  const failedTested = testedRoutes
    .filter((url) => !rankedUrls.has(url))
    .map((url) => ({ url, bytesPerSecond: 0, rangeSupported: false, sampleBytes: 0 }))
  const untestedRoutes = routes
    .filter((url) => !testedRoutes.includes(url))
    .map((url) => ({ url, bytesPerSecond: 0, rangeSupported: false, sampleBytes: 0 }))
  return [...rankedTested, ...failedTested, ...untestedRoutes]
}

async function fetchReleaseAsset(urls: string[], expectedSize: number, signal: AbortSignal, resumeAt = 0): Promise<Response> {
  let lastError: Error | undefined
  for (const url of urls) {
    try {
      const response = await networkFetch(url, {
        headers: {
          'Accept-Encoding': 'identity',
          ...(resumeAt > 0 ? { Range: `bytes=${resumeAt}-` } : {})
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_ROUTE_ATTEMPT_TIMEOUT_MS)])
      })
      const lengthHeader = response.headers.get('content-length')
      const contentLength = lengthHeader ? Number(lengthHeader) : Number.NaN
      if (resumeAt > 0 && response.status === 206 && response.body) {
        const range = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
        if (range && Number(range[1]) === resumeAt && Number(range[2]) + 1 === expectedSize && Number(range[3]) === expectedSize &&
          (!Number.isFinite(contentLength) || contentLength === expectedSize - resumeAt)) return response
        lastError = new Error('续传响应范围校验失败')
        await response.body.cancel().catch(() => undefined)
        continue
      }
      if (response.ok && response.body && (!Number.isFinite(contentLength) || contentLength === expectedSize)) return response
      await response.body?.cancel().catch(() => undefined)
      if (response.ok) {
        lastError = new Error('安装包响应大小不匹配')
        continue
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw new Error(`所有 GitHub 加速下载地址均失败：${lastError?.message ?? '未知错误'}`)
}

async function downloadSequentialAsset(
  url: string,
  outputPath: string,
  expectedSize: number,
  onProgress: (downloaded: number, total: number) => void
): Promise<void> {
  const timeout = createDownloadTimeout()
  try {
    let resumeAt = 0
    try {
      const existing = await open(outputPath, 'r')
      try {
        const size = (await existing.stat()).size
        if (size > 0 && size < expectedSize) resumeAt = size
      } finally {
        await existing.close()
      }
    } catch {
      resumeAt = 0
    }
    const response = await fetchReleaseAsset([url], expectedSize, timeout.signal, resumeAt)
    if (!response.body) throw new Error(`HTTP ${response.status}`)
    const append = resumeAt > 0 && response.status === 206
    let downloaded = append ? resumeAt : 0
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        timeout.touch()
        downloaded += chunk.length
        onProgress(downloaded, expectedSize)
        callback(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      progress,
      createWriteStream(outputPath, { flags: append ? 'a' : 'w' })
    )
  } finally {
    timeout.close()
  }
}

async function writeAt(file: Awaited<ReturnType<typeof open>>, buffer: Buffer, position: number): Promise<void> {
  let written = 0
  while (written < buffer.length) {
    const result = await file.write(buffer, written, buffer.length - written, position + written)
    if (result.bytesWritten <= 0) throw new Error('写入更新分片失败')
    written += result.bytesWritten
  }
}

async function downloadRangedAsset(
  url: string,
  outputPath: string,
  expectedSize: number,
  onProgress: (downloaded: number, total: number) => void
): Promise<void> {
  const statePath = `${outputPath}.ranges.json`
  const stateTempPath = `${statePath}.tmp`
  const rangeCount = Math.ceil(expectedSize / DOWNLOAD_RANGE_CHUNK_BYTES)
  let completed = new Set<number>()
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { size?: number; completed?: unknown }
    const stat = await open(outputPath, 'r').then((handle) => handle.stat().finally(() => handle.close()))
    if (state.size === expectedSize && Array.isArray(state.completed) && stat.size === expectedSize) {
      completed = new Set(state.completed.filter((index): index is number => Number.isInteger(index) && index >= 0 && index < rangeCount))
    }
  } catch {
    completed.clear()
  }
  const file = await open(outputPath, completed.size ? 'r+' : 'w+')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('分段下载超时')), DOWNLOAD_RANGE_TIMEOUT_MS)
  let downloaded = [...completed].reduce((total, index) => {
    const start = index * DOWNLOAD_RANGE_CHUNK_BYTES
    return total + Math.min(expectedSize, start + DOWNLOAD_RANGE_CHUNK_BYTES) - start
  }, 0)
  let stateWrites = Promise.resolve()
  const persistState = (): Promise<void> => {
    const snapshot = JSON.stringify({ size: expectedSize, completed: [...completed].sort((a, b) => a - b) })
    stateWrites = stateWrites.then(async () => {
      await writeFile(stateTempPath, snapshot, 'utf8')
      await rename(stateTempPath, statePath)
    })
    return stateWrites
  }
  try {
    await file.truncate(expectedSize)
    const ranges = Array.from({ length: rangeCount }, (_, index) => {
      const start = index * DOWNLOAD_RANGE_CHUNK_BYTES
      const end = Math.min(expectedSize, start + DOWNLOAD_RANGE_CHUNK_BYTES) - 1
      return { index, start, end }
    }).filter(({ index }) => !completed.has(index))
    onProgress(downloaded, expectedSize)
    let nextRange = 0
    const downloadRange = async ({ index, start, end }: { index: number; start: number; end: number }): Promise<void> => {
      const requestTimeout = createDownloadTimeout(controller.signal)
      try {
        const response = await networkFetch(url, {
          headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
          signal: requestTimeout.signal
        })
        if (response.status !== 206 || !response.body) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error(`分段下载不支持 Range（HTTP ${response.status}）`)
        }
        const range = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
        if (!range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== expectedSize) {
          await response.body.cancel().catch(() => undefined)
          throw new Error('分段下载范围校验失败')
        }
        const reader = response.body.getReader()
        let position = start
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            requestTimeout.touch()
            const buffer = Buffer.from(chunk.value)
            if (position + buffer.length > end + 1) throw new Error('分段下载数据超出范围')
            await writeAt(file, buffer, position)
            position += buffer.length
            downloaded += buffer.length
            onProgress(downloaded, expectedSize)
          }
        } finally {
          await reader.cancel().catch(() => undefined)
        }
        if (position !== end + 1) throw new Error('分段下载数据不完整')
        completed.add(index)
        await persistState()
      } catch (error) {
        controller.abort(error)
        throw error
      } finally {
        requestTimeout.close()
      }
    }
    const workers = Array.from({ length: Math.min(DOWNLOAD_RANGE_CONCURRENCY, ranges.length) }, async () => {
      while (nextRange < ranges.length) {
        const range = ranges[nextRange++]
        await downloadRange(range)
      }
    })
    const results = await Promise.allSettled(workers)
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
    await stateWrites
  } finally {
    clearTimeout(timeout)
    await file.close()
  }
}

async function getLatestRelease(): Promise<LatestReleaseInfo> {
  if (cachedLatestRelease && Date.now() - cachedLatestReleaseAt < 60_000) {
    return cachedLatestRelease
  }
  const urls = [
    ...GITHUB_ACCEL_PREFIXES.slice(0, GITHUB_API_PROBE_LIMIT).map((prefix) => `${prefix}https://api.github.com/repos/${REPOSITORY}/releases/latest`),
    `https://api.github.com/repos/${REPOSITORY}/releases/latest`
  ]
  const controllers = urls.map(() => new AbortController())
  let release: GitHubRelease | undefined
  let lastError: Error | undefined
  try {
    release = await Promise.any(urls.map(async (url, index) => {
      const response = await networkFetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.any([controllers[index].signal, AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS)])
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`GitHub 返回 HTTP ${response.status}`)
      }
      const result = await response.json() as GitHubRelease
      if (typeof result.tag_name !== 'string') throw new Error('GitHub Release 响应缺少版本标签')
      return result
    }))
  } catch (error) {
    lastError = error instanceof AggregateError
      ? new Error(error.errors.map((entry) => entry instanceof Error ? entry.message : String(entry)).join('；'))
      : error instanceof Error ? error : new Error(String(error))
  } finally {
    for (const controller of controllers) controller.abort()
  }
  if (!release) throw new Error(`检查更新失败：${lastError?.message ?? '所有 GitHub API 加速地址均失败'}`)
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const latestVersion = tag.replace(/^v/, '')
  if (!versionParts(latestVersion)) throw new Error('GitHub Release 版本号格式无效')
  const assetName = `cc-tv-windows-tauri2-${latestVersion}${RELEASE_ASSET_SUFFIX}-setup.exe`
  const asset = release.assets?.find((item) => item.name === assetName)
  if (!asset || typeof asset.size !== 'number' || asset.size < 1_000_000 || asset.size > MAX_INSTALLER_BYTES) {
    throw new Error('最新 Release 中没有有效的 Windows 安装包')
  }
  const downloadUrl = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
  let parsedDownloadUrl: URL
  try {
    parsedDownloadUrl = new URL(downloadUrl)
  } catch {
    throw new Error('GitHub Release 安装包地址无效')
  }
  if (parsedDownloadUrl.protocol !== 'https:' || parsedDownloadUrl.hostname !== 'github.com') {
    throw new Error('GitHub Release 安装包地址主机无效')
  }
  if (typeof asset.digest !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(asset.digest)) {
    throw new Error('GitHub 未提供安装包 SHA-256 校验值')
  }
  const result: LatestReleaseInfo = {
    currentVersion: process.env['CCTV_APP_VERSION'] || '1.0.32',
    latestVersion,
    notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
    assetName,
    assetSize: asset.size,
    downloadUrl,
    digest: asset.digest.slice('sha256:'.length).toLowerCase()
  }
  cachedLatestRelease = result
  cachedLatestReleaseAt = Date.now()
  return result
}

export async function checkForUpdate(): Promise<{ currentVersion: string; latestVersion: string; hasUpdate: boolean; notes: string }> {
  const release = await getLatestRelease()
  return {
    currentVersion: release.currentVersion,
    latestVersion: release.latestVersion,
    hasUpdate: compareVersions(release.latestVersion, release.currentVersion) > 0,
    notes: release.notes
  }
}

export async function downloadUpdate(version: string, onProgress: (downloaded: number, total: number) => void): Promise<string> {
  const release = await getLatestRelease()
  if (version !== release.latestVersion || compareVersions(release.latestVersion, release.currentVersion) <= 0) {
    throw new Error('更新版本已变化，请重新检查更新')
  }
  const filename = `cc-tv-windows-tauri2-update-${release.latestVersion}.exe`
  const outputPath = join(tmpdir(), filename)
  const partialPath = `${outputPath}.part`
  const downloadRoutes = await fastestReleaseDownloadRoutes(release.downloadUrl, release.assetSize)
  let hasRangedResumeState = false
  try {
    await readFile(`${partialPath}.ranges.json`, 'utf8')
    hasRangedResumeState = true
  } catch {
    hasRangedResumeState = false
  }
  let lastError: Error | undefined
  for (const route of downloadRoutes) {
    try {
      if (route.rangeSupported || hasRangedResumeState) {
        try {
          await downloadRangedAsset(route.url, partialPath, release.assetSize, onProgress)
          hasRangedResumeState = true
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          try {
            await readFile(`${partialPath}.ranges.json`, 'utf8')
            hasRangedResumeState = true
          } catch {
            hasRangedResumeState = false
          }
          continue
        }
      } else {
        await downloadSequentialAsset(route.url, partialPath, release.assetSize, onProgress)
      }
      const file = await open(partialPath, 'r')
      let integrityError: Error | undefined
      try {
        const signature = Buffer.alloc(2)
        await file.read(signature, 0, 2, 0)
        const info = await file.stat()
        if (signature.toString('ascii') !== 'MZ' || info.size !== release.assetSize) {
          integrityError = new Error('下载的安装包校验失败')
        } else {
          const hash = createHash('sha256')
          for await (const chunk of createReadStream(partialPath)) hash.update(chunk)
          if (hash.digest('hex') !== release.digest) integrityError = new Error('下载的安装包 SHA-256 校验失败')
        }
      } finally {
        await file.close()
      }
      if (integrityError) {
        await rm(partialPath, { force: true }).catch(() => undefined)
        await rm(`${partialPath}.ranges.json`, { force: true }).catch(() => undefined)
        throw integrityError
      }
      await rm(outputPath, { force: true })
      await rename(partialPath, outputPath)
      await rm(`${partialPath}.ranges.json`, { force: true }).catch(() => undefined)
      await rm(`${partialPath}.ranges.json.tmp`, { force: true }).catch(() => undefined)
      return outputPath
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw new Error(`所有 GitHub 加速下载链路均失败：${lastError?.message ?? '未知错误'}`)
}
