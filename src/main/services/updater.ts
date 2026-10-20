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
  'https://ghfast.top/https://github.com',
  'https://proxy.gitwarp.top/https://github.com',
  'https://ghproxy.net/https://github.com',
  'https://github.moeyy.xyz/https://github.com'
]
const GITHUB_RELEASE_ORIGIN = 'https://github.com'
const ORIGINAL_LINK_PROBE_TIMEOUT_MS = 2000
const MIRROR_LINK_PROBE_TIMEOUT_MS = 6000
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

async function probeReleaseUrl(url: string, timeoutMs: number): Promise<{ url: string; elapsed: number }> {
  const started = performance.now()
  const response = await networkFetch(url, {
    headers: { Range: 'bytes=0-524287' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (response.status !== 206 || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`HTTP ${response.status}`)
  }
  if (!/^bytes 0-524287\//i.test(response.headers.get('content-range') ?? '')) {
    await response.body.cancel().catch(() => undefined)
    throw new Error('不支持范围测速请求')
  }
  const reader = response.body.getReader()
  try {
    let received = 0
    while (received < 524288) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value?.byteLength ?? 0
    }
    if (received < 524288) throw new Error('镜像返回的数据不足')
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return { url, elapsed: performance.now() - started }
}

async function fastestReleaseDownloadUrls(assetPath: string): Promise<string[]> {
  const urls = [
    ...GITHUB_RELEASE_PROXIES.map((prefix) => `${prefix}/${assetPath}`),
    `${GITHUB_RELEASE_ORIGIN}/${assetPath}`
  ]
  const probes = await Promise.allSettled(urls.map((url, index) => probeReleaseUrl(
    url,
    index === urls.length - 1 ? ORIGINAL_LINK_PROBE_TIMEOUT_MS : MIRROR_LINK_PROBE_TIMEOUT_MS
  )))
  const successful = probes.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    .sort((left, right) => left.elapsed - right.elapsed)
  const failed = probes.flatMap((result, index) => result.status === 'rejected' ? [urls[index]] : [])
  if (!successful.length) throw new Error('GitHub 原始链接和加速链接均测速失败')
  return [...successful.map((item) => item.url), ...failed]
}

async function fetchReleaseAsset(urls: string[], expectedSize: number): Promise<Response> {
  let lastError: Error | undefined
  for (const url of urls) {
    try {
      const response = await networkFetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
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
  const releaseInstaller = `cc-tv-windows-tauri2-${latestVersion}-setup-release.exe`
  const standardInstaller = `cc-tv-windows-tauri2-${latestVersion}-setup.exe`
  const asset = release.assets?.find((item) => item.name === releaseInstaller)
    ?? release.assets?.find((item) => item.name === standardInstaller)
  if (!asset || typeof asset.size !== 'number' || asset.size < 1_000_000 || asset.size > MAX_INSTALLER_BYTES) {
    throw new Error('最新 Release 中没有有效的 Windows 安装包')
  }
  if (typeof asset.digest !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(asset.digest)) {
    throw new Error('GitHub 未提供安装包 SHA-256 校验值')
  }
  return {
    currentVersion: process.env['CCTV_APP_VERSION'] || '1.0.26',
    latestVersion,
    notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
    assetName: asset.name as string,
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
  const downloadUrls = await fastestReleaseDownloadUrls(assetPath)
  let lastError: Error | undefined
  for (const url of downloadUrls) {
    try {
      const response = await fetchReleaseAsset([url], release.assetSize)
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const lengthHeader = response.headers.get('content-length')
      const contentLength = lengthHeader ? Number(lengthHeader) : Number.NaN
      if (Number.isFinite(contentLength) && contentLength !== release.assetSize) {
        await response.body.cancel().catch(() => undefined)
        throw new Error('安装包大小不匹配')
      }
      let downloaded = 0
      const progress = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          downloaded += chunk.length
          onProgress(downloaded, release.assetSize)
          callback(null, chunk)
        }
      })
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        progress,
        createWriteStream(outputPath, { flags: 'w' })
      )
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
  throw new Error(`所有 GitHub 下载链路均失败：${lastError?.message ?? '未知错误'}`)
}
