import { createReadStream, createWriteStream } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import { networkFetch } from './http'

const REPOSITORY = 'JackEric6/cc-tv-windows-tauri2'
const RELEASE_ASSET_SUFFIX = ''
const GITHUB_ACCEL_PREFIXES = [
  'https://gh-proxy.org/',
  'https://gh.acmsz.top/',
  'https://xsadwsd.kdns.fr/',
  'https://ghpxy.hwinzniej.top/',
  'https://js.jiangss.shop/',
  'https://cfgh.ikgy.top/',
  'https://gh.meali.top/',
  'https://gg.z321.cc.cd/',
  'https://fastgit.cc/',
  'https://777.z321.cc.cd/',
  'https://github.mxw.qzz.io/',
  'https://gh.ddlc.top/',
  'https://gh.chjina.com/',
  'https://ghf.xn--eqrr82bzpe.top/',
  'https://ghproxy.cxkpro.top/',
  'https://gh.idayer.com/',
  'https://githubdog.com/',
  'https://git.yylx.win/',
  'https://ghproxy.imciel.com/',
  'https://ghm.078465.xyz/',
  'https://gitproxy.mrhjx.cn/',
  'https://gh.monlor.com/',
  'https://github.geekery.cn/',
  'https://github.ednovas.xyz/',
  'https://ghproxy.felicity.land/',
  'https://down.mxw.xx.kg/',
  'https://gh.qfmc0721.cc.cd/',
  'https://github.xxlab.tech/',
  'https://gh.jjj.gv.uy/',
  'https://gh.felicity.ac.cn/',
  'https://jiashu.1win.eu.org/',
  'https://github.tbap.top/',
  'https://gh.my-website.ccwu.cc/',
  'https://cdn.akaere.online/',
  'https://gh-proxy.com/',
  'https://tvv.tw/',
  'https://gh.07150721.xyz/',
  'https://github.dpik.top/',
  'https://g.blfrp.cn/',
  'https://gh.dpik.top/',
  'https://gh.sixyin.com/',
  'https://ghproxy.net/',
  'https://gh.noki.icu/',
  'https://ghfast.top/',
  'https://gh.catmak.name/',
  'https://github.ikgy.top/',
  'https://gh.inkchills.cn/',
  'https://git.669966.xyz/',
  'https://ghproxy.monkeyray.net/',
  'https://ghfile.geekertao.top/',
  'https://cdn.gh-proxy.com/',
  'https://j.1lin.dpdns.org/',
  'https://github.starrlzy.cn/',
  'https://github-proxy.memory-echoes.cn/',
  'https://gh.927223.xyz/',
  'https://gh.bugdey.us.kg/',
  'https://j.1win.ggff.net/',
  'https://gitproxy.127731.xyz/',
  'https://gh.b52m.cn/',
  'https://down.mxw.qzz.io/',
  'https://slink.ltd/',
  'https://github.tmby.shop/',
  'https://ghpr.cc/',
  'https://gh.tryxd.cn/',
  'https://gitproxy.click/',
  'https://github.chenc.dev/',
  'https://gh.jasonzeng.dev/',
  'https://gp.zkitefly.eu.org/',
  'https://ghproxy.1888866.xyz/',
  'https://ghp.arslantu.xyz/',
  'https://free.cn.eu.org/',
  'https://ghp.keleyaa.com/',
  'https://proxy.yaoyaoling.net/',
  'https://g.z321.cc.cd/',
  'https://gap.andyjin.website/',
  'https://gh.ruan.dpdns.org/',
  'https://github.nswrz.cn/',
  'https://gh.zhai.edu.pl/',
  'https://github-cf.947563.xyz/',
  'https://github.gohj99.site/',
  'https://githubproxy.gohj99.site/'
]
const GITHUB_API_PROBE_LIMIT = 12
const GITHUB_DOWNLOAD_PROBE_LIMIT = 56
const GITHUB_DOWNLOAD_PROBE_CONCURRENCY = 10
const GITHUB_DOWNLOAD_PROBE_SAMPLE_BYTES = 96 * 1024
const GITHUB_DOWNLOAD_PROBE_WINDOW_MS = 2200
const GITHUB_DOWNLOAD_FINALIST_COUNT = 3
const GITHUB_DOWNLOAD_FINAL_SAMPLE_BYTES = 1536 * 1024
const GITHUB_DOWNLOAD_FINAL_WINDOW_MS = 3000
const GITHUB_DOWNLOAD_MIN_SAMPLE_BYTES = 64 * 1024
const GITHUB_RELEASE_ORIGIN = 'https://github.com'
const ORIGINAL_LINK_PROBE_TIMEOUT_MS = 2000
const DOWNLOAD_RANGE_CHUNK_BYTES = 1024 * 1024
const DOWNLOAD_RANGE_CONCURRENCY = 4
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

async function fastestReleaseDownloadRoutes(assetPath: string, expectedSize: number): Promise<ReleaseDownloadRoute[]> {
  const routes = [
    ...GITHUB_ACCEL_PREFIXES.map((prefix) => `${prefix}${assetPath}`),
    `${GITHUB_RELEASE_ORIGIN}/${assetPath}`
  ]
  const testedRoutes = [
    ...routes.slice(0, GITHUB_DOWNLOAD_PROBE_LIMIT),
    routes[routes.length - 1]
  ]
  const probeBatch = async (urls: string[], bytes: number, windowMs: number): Promise<ReleaseDownloadRoute[]> => {
    const controller = new AbortController()
    const samples: Array<ReleaseDownloadRoute | undefined> = new Array(urls.length)
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < urls.length && !controller.signal.aborted) {
        const index = cursor++
        try {
          samples[index] = await probeReleaseUrl(
            urls[index],
            index === urls.length - 1 && urls[index] === routes[routes.length - 1]
              ? ORIGINAL_LINK_PROBE_TIMEOUT_MS
              : windowMs + 300,
            expectedSize,
            bytes,
            controller.signal
          )
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
    return samples.flatMap((sample) => sample ? [sample] : [])
  }

  const small = await probeBatch(testedRoutes, GITHUB_DOWNLOAD_PROBE_SAMPLE_BYTES, GITHUB_DOWNLOAD_PROBE_WINDOW_MS)
  const alive = small
    .filter((route) => route.sampleBytes >= GITHUB_DOWNLOAD_MIN_SAMPLE_BYTES)
    .sort((left, right) => right.bytesPerSecond - left.bytesPerSecond)
  if (!alive.length) {
    return routes.map((url) => ({ url, bytesPerSecond: 0, rangeSupported: false, sampleBytes: 0 }))
  }

  const finalists = alive.slice(0, GITHUB_DOWNLOAD_FINALIST_COUNT)
  const finalSamples = await probeBatch(
    finalists.map((route) => route.url),
    GITHUB_DOWNLOAD_FINAL_SAMPLE_BYTES,
    GITHUB_DOWNLOAD_FINAL_WINDOW_MS
  )
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
    const ranges = Array.from({ length: Math.ceil(expectedSize / DOWNLOAD_RANGE_CHUNK_BYTES) }, (_, index) => {
      const start = index * DOWNLOAD_RANGE_CHUNK_BYTES
      const end = Math.min(expectedSize, start + DOWNLOAD_RANGE_CHUNK_BYTES) - 1
      return { start, end }
    })
    let nextRange = 0
    const downloadRange = async ({ start, end }: { start: number; end: number }): Promise<void> => {
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
  } finally {
    clearTimeout(timeout)
    await file.close()
  }
}

async function getLatestRelease(): Promise<{ currentVersion: string; latestVersion: string; notes: string; assetName: string; assetSize: number; digest: string }> {
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
        signal: AbortSignal.any([controllers[index].signal, AbortSignal.timeout(12_000)])
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
  const assetName = `cc-tv-windows-tauri2-${latestVersion}-setup.exe`
  const asset = release.assets?.find((item) => item.name === assetName)
  if (!asset || typeof asset.size !== 'number' || asset.size < 1_000_000 || asset.size > MAX_INSTALLER_BYTES) {
    throw new Error('最新 Release 中没有有效的 Windows 安装包')
  }
  if (typeof asset.digest !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(asset.digest)) {
    throw new Error('GitHub 未提供安装包 SHA-256 校验值')
  }
  return {
    currentVersion: process.env['CCTV_APP_VERSION'] || '1.0.31',
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
