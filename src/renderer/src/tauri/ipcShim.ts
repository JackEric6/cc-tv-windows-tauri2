import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { open as openExternal } from '@tauri-apps/plugin-shell'
import { IPC } from '@shared/ipc'

interface BackendInfo {
  baseUrl: string
  token: string
}

interface BackendEvent {
  name: string
  payload: unknown
  [key: string]: unknown
}

type Listener = (event: unknown, payload: any) => void

const listeners = new Map<string, Set<Listener>>()
let backendInfo: Promise<BackendInfo> | undefined

function getBackendInfo(): Promise<BackendInfo> {
  if (!backendInfo) backendInfo = tauriInvoke<BackendInfo>('backend_info')
  return backendInfo
}

async function rpc<T>(channel: string, args: unknown[]): Promise<T> {
  const backend = await getBackendInfo()
  const response = await fetch(`${backend.baseUrl}/rpc`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${backend.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ channel, args })
  })
  const payload = await response.json() as { ok: boolean; result?: T; error?: string }
  if (!response.ok || !payload.ok) throw new Error(payload.error || `后台请求失败：HTTP ${response.status}`)
  return payload.result as T
}

export async function initializeTauriIpc(): Promise<void> {
  await listen<BackendEvent>('backend-event', ({ payload }) => {
    if (payload.name === 'webview-fetch') {
      void tauriInvoke('start_cz4k_webview', payload as Record<string, unknown>).catch((error: unknown) => {
        console.error('[tauri] 厂长隐藏浏览器启动失败', error)
      })
      return
    }
    if (payload.name === 'webview-close') {
        void tauriInvoke('close_cz4k_webview', { requestId: (payload.payload as { requestId: string }).requestId })
        .catch(() => undefined)
      return
    }
    for (const listener of listeners.get(payload.name) ?? []) listener(undefined, payload.payload)
  })
}

export const contextBridge = {
  exposeInMainWorld(name: string, value: unknown): void {
    Object.defineProperty(globalThis, name, { configurable: false, enumerable: true, value })
  }
}

export const ipcRenderer = {
  async invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    if (channel === IPC.updateInstall) {
      await tauriInvoke('install_downloaded_update', { path: String(args[0] ?? '') })
      return undefined as T
    }
    if (channel === IPC.windowAlwaysOnTop) {
      await tauriInvoke('set_always_on_top', { enabled: Boolean(args[0]) })
      return undefined as T
    }
    if (channel === IPC.openExternal) {
      const url = String(args[0] ?? '')
      if (!/^(https?:\/\/|mailto:)/i.test(url)) throw new Error('仅支持打开 http/https 或 mailto 链接')
      await openExternal(url)
      return undefined as T
    }
    if (channel === IPC.sourcesPickFile) {
      const selected = await openDialog({
        title: '选择配置文件',
        multiple: false,
        filters: [{ name: 'JSON 配置', extensions: ['json'] }]
      })
      return (typeof selected === 'string' ? selected : null) as T
    }
    return rpc<T>(channel, args)
  },
  on(channel: string, listener: Listener): void {
    const set = listeners.get(channel) ?? new Set<Listener>()
    set.add(listener)
    listeners.set(channel, set)
  },
  removeListener(channel: string, listener: Listener): void {
    const set = listeners.get(channel)
    set?.delete(listener)
    if (set?.size === 0) listeners.delete(channel)
  }
}
