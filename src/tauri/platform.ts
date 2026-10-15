import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { PacProxyAgent } from 'pac-proxy-agent'
import { Agent, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici'

export interface BrowserPageResult {
  html: string
  resourceUrls: string[]
  cookies?: string
}

const pendingBrowserPages = new Map<
  string,
  { resolve: (value: BrowserPageResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>()

const dataDirectory = process.env['CCTV_DATA_DIR'] || join(process.cwd(), 'data')
let activeDispatcher: Agent | EnvHttpProxyAgent | undefined
let pacLoader: PacProxyAgent<string> | undefined
let pacResolver: ((url: string | URL) => Promise<string>) | undefined
const pacDispatchers = new Map<string, Agent | ProxyAgent>()

export const app = {
  getPath(name: string): string {
    if (name === 'exe') return process.execPath
    if (name === 'app') return process.cwd()
    return dataDirectory
  }
}

export async function networkFetch(url: string | URL, options: RequestInit = {}): Promise<Response> {
  if (!pacResolver) return globalThis.fetch(url, options)
  const target = url instanceof URL ? url : new URL(url)
  const directives = (await pacResolver(target)).split(';').map((item) => item.trim()).filter(Boolean)
  for (const directive of directives) {
    if (/^DIRECT$/i.test(directive)) return fetchWithDispatcher(url, options, activeDispatcher)
    const match = /^(?:PROXY|HTTP|HTTPS)\s+(.+)$/i.exec(directive)
    if (!match) continue
    const scheme = /^HTTPS/i.test(directive) ? 'https' : 'http'
    const proxyUrl = `${scheme}://${match[1]}`
    let dispatcher = pacDispatchers.get(proxyUrl)
    if (!dispatcher) {
      dispatcher = new ProxyAgent(proxyUrl)
      pacDispatchers.set(proxyUrl, dispatcher)
    }
    return fetchWithDispatcher(url, options, dispatcher)
  }
  throw new Error(`Windows PAC 未返回可用代理：${target.origin}`)
}

function fetchWithDispatcher(
  url: string | URL,
  options: RequestInit,
  dispatcher: Agent | EnvHttpProxyAgent | ProxyAgent | undefined
): Promise<Response> {
  if (!dispatcher) return globalThis.fetch(url, options)
  return globalThis.fetch(url, { ...options, dispatcher } as RequestInit)
}

function registryValue(name: string): string | undefined {
  try {
    const output = execFileSync('reg.exe', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const line = output.split(/\r?\n/).find((item) => item.trim().startsWith(name))
    return line?.trim().split(/\s{2,}/).at(-1)
  } catch {
    return undefined
  }
}

function normalizeProxy(value: string | undefined): string | undefined {
  if (!value) return undefined
  const proxy = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`
  try {
    const url = new URL(proxy)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

function readWindowsProxy(): { httpProxy?: string; httpsProxy?: string; noProxy?: string; autoConfigUrl?: string } {
  const enabled = registryValue('ProxyEnable')
  const configured = enabled === '0x1' ? registryValue('ProxyServer') : undefined
  const bypass = enabled === '0x1' ? registryValue('ProxyOverride') : undefined
  const entries = new Map<string, string>()
  for (const item of configured?.split(';') ?? []) {
    const separator = item.indexOf('=')
    if (separator < 0) {
      if (item.trim()) entries.set('http', item.trim())
      continue
    }
    entries.set(item.slice(0, separator).trim().toLowerCase(), item.slice(separator + 1).trim())
  }
  const shared = entries.get('http')
  const noProxy = bypass
    ?.replace(/<local>/gi, 'localhost,127.0.0.1,::1,*.local')
    .replace(/;/g, ',')
  return {
    httpProxy: normalizeProxy(shared),
    httpsProxy: normalizeProxy(entries.get('https') ?? shared),
    noProxy,
    autoConfigUrl: registryValue('AutoConfigURL')
  }
}

export async function applyProxyMode(useSystemProxy: boolean): Promise<void> {
  const previous = activeDispatcher
  pacLoader?.destroy()
  pacLoader = undefined
  pacResolver = undefined
  for (const dispatcher of pacDispatchers.values()) await dispatcher.close().catch(() => undefined)
  pacDispatchers.clear()

  const systemProxy = useSystemProxy ? readWindowsProxy() : undefined
  const pacUrl = systemProxy?.autoConfigUrl
  if (pacUrl && /^(?:https?:|file:)/i.test(pacUrl)) {
    try {
      pacLoader = new PacProxyAgent(pacUrl)
      pacResolver = await pacLoader.getResolver()
    } catch (error) {
      pacLoader?.destroy()
      pacLoader = undefined
      console.warn('[proxy] Windows PAC 加载失败，将使用静态代理设置', error)
    }
  }

  activeDispatcher = !useSystemProxy || pacResolver
    ? new Agent()
    : new EnvHttpProxyAgent(systemProxy)
  setGlobalDispatcher(activeDispatcher)
  if (previous) await previous.close().catch(() => undefined)
}

export function emitBackendEvent(name: string, payload: unknown): void {
  process.stdout.write(`${JSON.stringify({ type: 'event', name, payload })}\n`)
}

export function requestCz4kBrowserPage(url: string, referrer: string, timeoutMs = 30_000): Promise<BrowserPageResult> {
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBrowserPages.delete(requestId)
      emitBackendEvent('webview-close', { requestId })
      reject(new Error(`厂长页面等待超时（${Math.ceil(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    pendingBrowserPages.set(requestId, { resolve, reject, timer })
    emitBackendEvent('webview-fetch', { requestId, url, referrer })
  })
}

export function completeCz4kBrowserPage(
  requestId: string,
  result?: BrowserPageResult,
  error?: string
): boolean {
  const pending = pendingBrowserPages.get(requestId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingBrowserPages.delete(requestId)
  emitBackendEvent('webview-close', { requestId })
  if (error) pending.reject(new Error(error))
  else if (result) pending.resolve(result)
  else pending.reject(new Error('厂长浏览器没有返回页面数据'))
  return true
}
