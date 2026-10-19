import { createReadStream, createWriteStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import { networkFetch } from './http'

const REPOSITORY = 'JackEric6/cc-tv-windows-tauri2'
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

async function getLatestRelease(): Promise<{ currentVersion: string; latestVersion: string; notes: string; assetName: string; assetSize: number; digest: string }> {
  const response = await networkFetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`检查更新失败：GitHub 返回 HTTP ${response.status}`)
  const release = await response.json() as GitHubRelease
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
    currentVersion: process.env['CCTV_APP_VERSION'] || '1.0.24',
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

export async function downloadUpdate(version: string): Promise<string> {
  const release = await getLatestRelease()
  if (version !== release.latestVersion || compareVersions(release.latestVersion, release.currentVersion) <= 0) {
    throw new Error('更新版本已变化，请重新检查更新')
  }
  const filename = `cc-tv-windows-tauri2-update-${release.latestVersion}-${randomUUID()}.exe`
  const outputPath = join(tmpdir(), filename)
  const downloadUrl = `https://ghproxy.net/https://github.com/${REPOSITORY}/releases/download/${release.latestVersion}/${release.assetName}`
  const response = await networkFetch(downloadUrl, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`下载更新失败：HTTP ${response.status}`)
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength !== release.assetSize) {
    throw new Error(`安装包大小不匹配：预期 ${release.assetSize} 字节，收到 ${contentLength} 字节`)
  }
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(outputPath, { flags: 'w' }))
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
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined)
    throw error
  }
  return outputPath
}
