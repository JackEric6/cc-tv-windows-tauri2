import { createReadStream, createWriteStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import { networkFetch } from './http'

const REPOSITORY = 'JackEric6/cc-tv-windows-tauri2'
const GITHUB_API_PROXIES = [
  'https://gh-proxy.com/https://api.github.com',
  'https://gh.llkk.cc/https://api.github.com',
  'https://ghfast.top/https://api.github.com'
]
const GITHUB_RELEASE_PROXIES = [
  'https://gh.llkk.cc/https://github.com',
  'https://gh-proxy.com/https://github.com',
  'https://ghfast.top/https://github.com'
]
const GITHUB_RELEASE_ORIGIN = 'https://github.com'
const ORIGINAL_LINK_PROBE_TIMEOUT_MS = 2000
const MIRROR_LINK_PROBE_TIMEOUT_MS = 6000
const DOWNLOAD_PROBE_BYTES = 64 * 1024
const DOWNLOAD_RANGE_COUNT = 4
const DOWNLOAD_RANGE_TIMEOUT_MS = 10 * 60_000
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
const MAX_INSTALLER_BYTES = 120 * 1024 * 1024

interface GitHubRelease {
  tag_name?: unknown
  body?: unknown
  assets?: Array<{ name?: unknown; size?: unknown; digest?: unknown; content_type?: unknown }>
}

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
  expectedSize: number
): Promise<ReleaseDownloadRoute> {
  const started = performance.now()
  const response = await networkFetch(url, {
    headers: { Range: `bytes=0-${DOWNLOAD_PROBE_BYTES - 1}`, 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`HTTP ${response.status}`)
  }

  const rangeSupported = response.status === 206
  let sampleBytes = DOWNLOAD_PROBE_BYTES
  if (rangeSupported) {
    const range = /^bytes\s+0-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '')
    if (!range || Number(range[2]) !== expectedSize) {
      await response.body.cancel().catch(() => undefined)
      throw new Error('Range 响应格式无效')
    }
    sampleBytes = Math.min(sampleBytes, Number(range[1]) + 1)
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
  try {
    while (received < sampleBytes) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value?.byteLength ?? 0
    }
    if (received === 0) throw new Error('测速链路没有返回数据')
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const elapsed = Math.max(1, performance.now() - started)
  return { url, bytesPerSecond: received * 1000 / elapsed, rangeSupported }
}

async function fastestReleaseDownloadRoutes(assetPath: string, expectedSize: number): Promise<ReleaseDownloadRoute[]> {
  const urls = [
    ...GITHUB_RELEASE_PROXIES.map((prefix) => `${prefix}/${assetPath}`),
    `${GITHUB_RELEASE_ORIGIN}/${assetPath}`
  ]
  const probes = await Promise.allSettled(urls.map((url, index) => probeReleaseUrl(
    url,
    index === urls.length - 1 ? ORIGINAL_LINK_PROBE_TIMEOUT_MS : MIRROR_LINK_PROBE_TIMEOUT_MS,
    expectedSize
  )))
  const successful = probes.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    .sort((left, right) => right.bytesPerSecond - left.bytesPerSecond)
  const failed = probes.flatMap((result, index) => result.status === 'rejected'
    ? [{ url: urls[index], bytesPerSecond: 0, rangeSupported: false }]
    : [])
  // A failed sample is not proof that the full GET is unusable; preserve every route for download fallback.
  return [...successful, ...failed]
}

async function fetchReleaseAsset(urls: string[], expectedSize: number, signal: AbortSignal): Promise<Response> {
  let lastError: Error | undefined
  for (const url of urls) {
    try {
      const response = await networkFetch(url, {
        headers: { 'Accept-Encoding': 'identity' },
        signal
      })
      const lengthHeader = response.headers.get('content-length')
      const contentLength = lengthHeader ? Number(lengthHeader) : Number.NaN
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
    const response = await fetchReleaseAsset([url], expectedSize, timeout.signal)
    if (!response.body) throw new Error(`HTTP ${response.status}`)
    let downloaded = 0
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
      createWriteStream(outputPath, { flags: 'w' })
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
  const file = await open(outputPath, 'w+')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('分段下载超时')), DOWNLOAD_RANGE_TIMEOUT_MS)
  let downloaded = 0
  try {
    await file.truncate(expectedSize)
    const ranges = Array.from({ length: DOWNLOAD_RANGE_COUNT }, (_, index) => {
      const start = Math.floor(expectedSize * index / DOWNLOAD_RANGE_COUNT)
      const end = Math.floor(expectedSize * (index + 1) / DOWNLOAD_RANGE_COUNT) - 1
      return { start, end }
    })
    const results = await Promise.allSettled(ranges.map(async ({ start, end }) => {
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
      } catch (error) {
        controller.abort(error)
        throw error
      } finally {
        requestTimeout.close()
      }
    }))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  } finally {
    clearTimeout(timeout)
    await file.close()
  }
}

async function getLatestRelease(): Promise<{ currentVersion: string; latestVersion: string; notes: string; assetName: string; assetSize: number; digest: string }> {
  let release: GitHubRelease | undefined
  let lastError: Error | undefined
  for (const prefix of GITHUB_API_PROXIES) {
    try {
      const response = await networkFetch(`${prefix}/repos/${REPOSITORY}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(12_000)
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        lastError = new Error(`GitHub 返回 HTTP ${response.status}`)
        continue
      }
      release = await response.json() as GitHubRelease
      break
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  if (!release) throw new Error(`检查更新失败：${lastError?.message ?? '所有 GitHub API 加速地址均失败'}`)
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const latestVersion = tag.replace(/^v/, '')
  if (!versionParts(latestVersion)) throw new Error('GitHub Release 版本号格式无效')
  const assetName = `cc-tv-windows-tauri2-${latestVersion}-setup.exe`
  const asset = release.assets?.find((item) => item.name === assetName)
  if (!asset || typeof asset.size !== 'number' || asset.size < 1_000_000 || asset.size > MAX_INSTALLER_BYTES) {
    throw new Error('最新 Release 中没有有效的 Windows 安装包')
  }
  if (typeof asset.digest !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(asset.digest)) {
    throw new Error('GitHub 未提供安装包 SHA-256 校验值')
  }
  return {
    currentVersion: process.env['CCTV_APP_VERSION'] || '1.0.28',
    latestVersion,
    notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
    assetName,
    assetSize: asset.size,
    digest: asset.digest.slice('sha256:'.length).toLowerCase()
  }
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
  const filename = `cc-tv-windows-tauri2-update-${release.latestVersion}-${randomUUID()}.exe`
  const outputPath = join(tmpdir(), filename)
  const assetPath = `${REPOSITORY}/releases/download/${release.latestVersion}/${release.assetName}`
  const downloadRoutes = await fastestReleaseDownloadRoutes(assetPath, release.assetSize)
  let lastError: Error | undefined
  for (const route of downloadRoutes) {
    try {
      if (route.rangeSupported) {
        try {
          await downloadRangedAsset(route.url, outputPath, release.assetSize, onProgress)
        } catch {
          await rm(outputPath, { force: true }).catch(() => undefined)
          await downloadSequentialAsset(route.url, outputPath, release.assetSize, onProgress)
        }
      } else {
        await downloadSequentialAsset(route.url, outputPath, release.assetSize, onProgress)
      }
      const file = await open(outputPath, 'r')
      try {
        const signature = Buffer.alloc(2)
        await file.read(signature, 0, 2, 0)
        const info = await file.stat()
        if (signature.toString('ascii') !== 'MZ' || info.size !== release.assetSize) {
          throw new Error('下载的安装包校验失败')
        }
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(outputPath)) hash.update(chunk)
        if (hash.digest('hex') !== release.digest) throw new Error('下载的安装包 SHA-256 校验失败')
      } finally {
        await file.close()
      }
      return outputPath
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => undefined)
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw new Error(`所有 GitHub 加速下载链路均失败：${lastError?.message ?? '未知错误'}`)
}
