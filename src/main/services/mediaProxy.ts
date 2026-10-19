import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { app, networkFetch } from '../../tauri/platform'
import { purifyM3u8 } from './m3u8Purify'
import { normalizeRequestHeaders } from './http'

let server: Server | undefined
let localBase = ''
let secret = ''
let listening: Promise<void> | undefined

function validHttpUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('媒体地址只支持 HTTP 或 HTTPS')
  return url
}

function proxyUri(url: string, headers: Record<string, string>, purify: boolean): string {
  const query = new URLSearchParams({ url, headers: Buffer.from(JSON.stringify(headers)).toString('base64url'), purify: purify ? '1' : '0' })
  return `${localBase}/${secret}?${query}`
}

type ProxyResponse = Readable & {
  statusCode?: number
  headers: Record<string, string>
}

async function fetchUpstream(
  url: string,
  method: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<{ response: ProxyResponse; finalUrl: string }> {
  const upstream = await networkFetch(url, {
    method,
    headers: normalizeRequestHeaders(headers),
    redirect: 'follow',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)])
  })
  const stream = upstream.body
    ? Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>)
    : Readable.from([])
  Object.assign(stream, {
    statusCode: upstream.status,
    headers: Object.fromEntries(upstream.headers.entries())
  })
  return { response: stream as ProxyResponse, finalUrl: upstream.url || url }
}

function readResponseText(response: ProxyResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    response.on('error', reject)
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

async function listen(): Promise<void> {
  if (localBase) return
  if (!listening) {
    listening = new Promise<void>((resolve, reject) => {
      server = createServer(async (request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*')
        response.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type')
        response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Type')
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        if (request.method === 'OPTIONS') {
          response.writeHead(204).end()
          return
        }
        try {
          const incoming = new URL(request.url ?? '/', 'http://127.0.0.1')
          const route = incoming.pathname.split('/').filter(Boolean)
          if (route[0] === secret && route[1] === 'offline') {
            await serveOfflineFile(route.slice(2), request.method ?? 'GET', request.headers.range, response)
            return
          }
          if (incoming.pathname !== `/${secret}` || !['GET', 'HEAD'].includes(request.method ?? '')) {
            response.writeHead(404).end()
            return
          }
          const method = request.method === 'HEAD' ? 'HEAD' : 'GET'
          const target = validHttpUrl(incoming.searchParams.get('url') ?? '')
          const storedHeaders = incoming.searchParams.get('headers') ?? ''
          const sourceHeaders = storedHeaders ? JSON.parse(Buffer.from(storedHeaders, 'base64url').toString('utf8')) as Record<string, string> : {}
          const purify = incoming.searchParams.get('purify') === '1'
          const headers = normalizeRequestHeaders({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
            ...sourceHeaders
          })
          const range = request.headers.range
          if (range) headers.Range = range
          const upstreamRequest = new AbortController()
          response.once('close', () => {
            if (!response.writableEnded) upstreamRequest.abort()
          })
          const { response: upstream, finalUrl } = await fetchUpstream(target.href, method, headers, upstreamRequest.signal)
          response.statusCode = upstream.statusCode ?? 502
          for (const name of ['accept-ranges', 'content-length', 'content-range', 'content-type', 'last-modified', 'etag']) {
            const value = upstream.headers[name]
            if (value) response.setHeader(name, value)
          }
          const contentType = String(upstream.headers['content-type'] ?? '')
          const upstreamOk = (upstream.statusCode ?? 0) >= 200 && (upstream.statusCode ?? 0) < 300
          if (method !== 'HEAD' && upstreamOk && (contentType.includes('mpegurl') || /\.m3u8(?:$|[?#])/i.test(finalUrl))) {
            const body = await readResponseText(upstream)
            const clean = purify ? purifyM3u8(finalUrl, body) : body
            const rewritten = clean.split(/\r?\n/).map((line) => {
              const trimmed = line.trim()
              if (!trimmed) return line
              if (trimmed.startsWith('#')) {
                return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
                  if (/^(?:data|skd):/i.test(uri)) return `URI="${uri}"`
                  return `URI="${proxyUri(new URL(uri, finalUrl).href, sourceHeaders, purify)}"`
                })
              }
              return proxyUri(new URL(trimmed, finalUrl).href, sourceHeaders, purify)
            }).join('\n')
            response.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8')
            response.setHeader('Content-Length', Buffer.byteLength(rewritten))
            response.end(rewritten)
            return
          }
          if (method === 'HEAD') {
            response.end()
            return
          }
          await pipeline(upstream, response)
        } catch (error) {
          if (!response.headersSent) {
            response.statusCode = 502
            response.setHeader('Content-Type', 'text/plain; charset=utf-8')
            response.end((error as Error).message)
          } else if (!response.destroyed) {
            response.destroy(error as Error)
          }
        }
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server?.address()
        if (!address || typeof address === 'string') {
          reject(new Error('本地媒体代理启动失败'))
          return
        }
        secret = randomBytes(18).toString('hex')
        localBase = `http://127.0.0.1:${address.port}`
        server?.unref()
        resolve()
      })
    }).finally(() => {
      listening = undefined
    })
  }
  await listening
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.m3u8': return 'application/vnd.apple.mpegurl'
    case '.ts': return 'video/mp2t'
    case '.m4s': return 'video/iso.segment'
    case '.mp4': return 'video/mp4'
    case '.m4a': return 'audio/mp4'
    case '.aac': return 'audio/aac'
    case '.vtt': return 'text/vtt; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

async function serveOfflineFile(
  route: string[],
  method: string,
  range: string | undefined,
  response: ServerResponse
): Promise<void> {
  if (!['GET', 'HEAD'].includes(method) || route.length < 2 || !/^[a-f0-9]{24}$/i.test(route[0])) {
    response.writeHead(404).end()
    return
  }
  let segments: string[]
  try {
    segments = route.slice(1).map(decodeURIComponent)
  } catch {
    response.writeHead(400).end()
    return
  }
  if (segments.some((part) => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))) {
    response.writeHead(400).end()
    return
  }
  const root = resolve(join(app.getPath('userData'), 'offline-videos'))
  const file = resolve(root, route[0], ...segments)
  if (!relative(root, file) || relative(root, file).startsWith(`..${sep}`) || relative(root, file) === '..') {
    response.writeHead(400).end()
    return
  }
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    let start = 0
    let end = info.size - 1
    let status = 200
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/)
      if (!match) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end()
        return
      }
      if (!match[1] && match[2]) start = Math.max(0, info.size - Number(match[2]))
      else start = Number(match[1] || 0)
      if (match[1] && match[2]) end = Math.min(info.size - 1, Number(match[2]))
      if (start > end || start >= info.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end()
        return
      }
      status = 206
    }
    response.setHeader('Content-Type', mimeType(file))
    response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader('Content-Length', Math.max(0, end - start + 1))
    if (status === 206) response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`)
    response.writeHead(status)
    if (method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(file, { start, end }).on('error', () => response.destroy()).pipe(response)
  } catch {
    response.writeHead(404).end()
  }
}

export async function prepareMediaUrl(
  url: string,
  headers: Record<string, string> = {},
  purify = true,
  forceProxy = false
): Promise<string> {
  const target = validHttpUrl(url)
  if (!forceProxy && !/\.m3u8(?:$|[?#])/i.test(target.href) && !/\/hls\//i.test(target.pathname)) return url
  await listen()
  return proxyUri(target.href, headers, purify)
}

export async function prepareOfflineMediaUrl(id: string, mediaFile: string): Promise<string> {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error('离线任务编号无效')
  const parts = mediaFile.split(/[\\/]/)
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('离线媒体路径无效')
  }
  await listen()
  return `${localBase}/${secret}/offline/${id}/${parts.map(encodeURIComponent).join('/')}`
}

export function closeMediaProxy(): void {
  server?.close()
  server = undefined
  localBase = ''
  secret = ''
}
