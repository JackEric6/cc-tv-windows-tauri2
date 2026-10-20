import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { IPC } from '@shared/ipc'
import type { AiFrame, AiSummaryInput, AppSettings, FavoriteItem, HistoryItem, SearchOptions, SearchResponse } from '@shared/types'
import { getVodDetail } from '../main/services/detail'
import { summarizeEpisode, summarizeEpisodeVisual } from '../main/services/ai'
import { browseCategory, clearCategoryCache, listCategories } from '../main/services/category'
import { clearHomeCache, expandHomeSection, listHomeSections } from '../main/services/home'
import {
  clearFavorites, clearHistory, getLibrary, recordHistory, removeFavorite,
  removeHistoryGroup, toggleFavorite
} from '../main/services/library'
import { applyProxyMode } from '../main/services/proxy'
import { detectPlayers, openInPlayer } from '../main/services/player'
import {
  addParse, listParses, removeParse, resetParseStats, resolvePlayUrl, testParse
} from '../main/services/parse'
import type { ResolveOptions } from '../main/services/parse'
import { cancelSearch, searchAll, suggestSearchKeywords } from '../main/services/search'
import { getSettings, saveSettings } from '../main/services/settings'
import { getSites, setSiteAreaEnabled, setSiteEnabled, setSitesEnabled, testSite } from '../main/services/sites'
import { addPreset, ensureBundledSources, listPresets } from '../main/services/presets'
import {
  addSource, hydrate, listSources, removeSource, syncAll, syncSource, updateSource
} from '../main/services/sources'
import { flushStore } from '../main/services/store'
import { resolveEpisodeForPlayer } from '../main/services/playback'
import { cancelDanmaku, loadDanmaku, searchDanmaku } from '../main/services/danmaku'
import { closeMediaProxy } from '../main/services/mediaProxy'
import { checkForUpdate, downloadUpdate } from '../main/services/updater'
import { submitFeedback } from '../main/services/feedback'
import {
  addOfflineTask, cancelOfflineTask, deleteOfflineTask, getOfflinePlayback,
  listOfflineTasks, pauseOfflineTask, retryOfflineTask
} from '../main/services/offlineCache'
import { completeCz4kBrowserPage, emitBackendEvent, type BrowserPageResult } from './platform'

type Handler = (...args: any[]) => unknown | Promise<unknown>
const handlers = new Map<string, Handler>()

function register(channel: string, handler: Handler): void {
  handlers.set(channel, handler)
}

function registerHandlers(): void {
  register(IPC.appInfo, () => ({
    version: process.env['CCTV_APP_VERSION'] || '1.0.28',
    webview2: 'Evergreen',
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    userData: process.env['CCTV_DATA_DIR'] || ''
  }))

  register(IPC.updateCheck, () => checkForUpdate())
  register(IPC.updateDownload, (version: string) => downloadUpdate(version, (downloaded, total) => {
    emitBackendEvent(IPC.updateDownloadProgress, { downloaded, total })
  }))
  register(IPC.feedbackSubmit, (content: string, version: string) => submitFeedback(content, version))

  register(IPC.settingsGet, () => getSettings())
  register(IPC.settingsSet, async (patch: Partial<AppSettings>) => {
    if (typeof patch.useSystemProxy === 'boolean') await applyProxyMode(patch.useSystemProxy)
    return saveSettings(patch)
  })
  register(IPC.sourcesList, () => listSources())
  register(IPC.sourcesAdd, async (input) => {
    const result = await addSource(input)
    clearCategoryCache()
    clearHomeCache()
    return result
  })
  register(IPC.sourcesUpdate, async (id: string, patch) => {
    const result = await updateSource(id, patch)
    clearCategoryCache()
    clearHomeCache()
    return result
  })
  register(IPC.sourcesRemove, async (id: string) => {
    await removeSource(id)
    clearCategoryCache()
    clearHomeCache()
  })
  register(IPC.sourcesSync, async (id: string) => {
    const result = await syncSource(id)
    clearCategoryCache()
    clearHomeCache()
    return result
  })
  register(IPC.sourcesSyncAll, async () => {
    const result = await syncAll()
    clearCategoryCache()
    clearHomeCache()
    return result
  })
  register(IPC.sourcesPresets, () => listPresets())
  register(IPC.sourcesAddPreset, (id: string) => addPreset(id))

  register(IPC.sitesList, () => getSites())
  register(IPC.sitesSetEnabled, (key: string, enabled: boolean) => setSiteEnabled(key, enabled))
  register(IPC.sitesSetAreaEnabled, async (key: string, area: 'home' | 'search' | 'category', enabled: boolean) => {
    await setSiteAreaEnabled(key, area, enabled)
    clearCategoryCache()
    clearHomeCache()
  })
  register(IPC.sitesSetAllEnabled, (keys: string[], enabled: boolean) => setSitesEnabled(keys, enabled))
  register(IPC.sitesTest, (key: string) => testSite(key))

  register(IPC.searchRun, (wd: string, options?: SearchOptions): Promise<SearchResponse> =>
    searchAll(wd, options ?? {}, (result, done, total) => {
      emitBackendEvent(IPC.searchProgress, { wd, done, total, result })
    })
  )
  register(IPC.searchCancel, () => cancelSearch())
  register(IPC.searchSuggest, async (keyword: string): Promise<string[]> => {
    try {
      return await suggestSearchKeywords(String(keyword ?? ''))
    } catch {
      return []
    }
  })
  register(IPC.detailGet, (siteKey: string, vodId: string) => getVodDetail(siteKey, vodId))
  register(IPC.categoryList, () => listCategories())
  register(IPC.categoryBrowse, (bucket: string, sub: string, page: number, siteKey?: string) =>
    browseCategory(bucket, sub, page, siteKey)
  )

  register(IPC.libraryGet, () => getLibrary())
  register(IPC.libraryToggleFavorite, (input: Omit<FavoriteItem, 'addedAt'>) => toggleFavorite(input))
  register(IPC.libraryRemoveFavorite, (key: string) => removeFavorite(key))
  register(IPC.libraryClearFavorites, () => clearFavorites())
  register(IPC.libraryRecord, (input: Omit<HistoryItem, 'updatedAt'>) => recordHistory(input))
  register(IPC.libraryRemoveHistory, (key: string) => removeHistoryGroup(key))
  register(IPC.libraryClearHistory, () => clearHistory())

  register(IPC.playerDetect, () => detectPlayers())
  register(IPC.playerOpen, (url: string, title: string) => openInPlayer(url, title))
  register(IPC.playerResolveEpisode, (siteKey: string, url: string) => resolveEpisodeForPlayer(siteKey, url))
  register(IPC.offlineList, () => listOfflineTasks())
  register(IPC.offlineAdd, (input) => addOfflineTask(input))
  register(IPC.offlinePause, (id: string) => pauseOfflineTask(id))
  register(IPC.offlineRetry, (id: string) => retryOfflineTask(id))
  register(IPC.offlineCancel, (id: string) => cancelOfflineTask(id))
  register(IPC.offlineDelete, (id: string) => deleteOfflineTask(id))
  register(IPC.offlinePlay, (id: string) => getOfflinePlayback(id))

  register(IPC.danmakuSearch, (title: string, episode: string, requestId: string) =>
    searchDanmaku(title, episode, requestId)
  )
  register(IPC.danmakuLoad, (id: string, requestId: string, cacheKey?: string) =>
    loadDanmaku(id, requestId, cacheKey)
  )
  register(IPC.danmakuCancel, (requestId: string) => cancelDanmaku(requestId))

  register(IPC.parseList, () => listParses())
  register(IPC.parseResolve, (url: string, options: ResolveOptions) => resolvePlayUrl(url, options))
  register(IPC.parseTest, (url: string, target?: string) => testParse(url, target))
  register(IPC.parseAdd, (input: { name?: string; type?: number; url: string; flags?: string[] }) => addParse(input))
  register(IPC.parseRemove, (url: string) => removeParse(url))
  register(IPC.parseResetStats, () => resetParseStats())

  register(IPC.homeSections, (force?: boolean) => listHomeSections(force === true))
  register(IPC.homeSectionExpand, (key: string) => expandHomeSection(key))
  register(IPC.aiSummary, (input: AiSummaryInput) => summarizeEpisode(input))
  register(IPC.aiSummaryVisual, (input: AiSummaryInput, frames: AiFrame[]) =>
    summarizeEpisodeVisual(input, frames)
  )
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.byteLength,
    'Cache-Control': 'no-store'
  })
  response.end(data)
}

function readJson(request: IncomingMessage, limit = 20 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > limit) {
        reject(new Error('请求内容过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.once('error', reject)
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求内容不是有效 JSON'))
      }
    })
  })
}

function validToken(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Private-Network', 'true')
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end()
    return
  }
  const route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (route === '/health' && request.method === 'GET') {
    sendJson(response, 200, { ready: true })
    return
  }
  if (route === '/webview-result' && request.method === 'POST') {
    const input = await readJson(request)
    const result = input.result as BrowserPageResult | undefined
    const accepted = completeCz4kBrowserPage(String(input.requestId ?? ''), result, input.error)
    sendJson(response, accepted ? 200 : 404, { ok: accepted })
    return
  }
  if (!validToken(request, token)) {
    sendJson(response, 401, { ok: false, error: '未授权的本地请求' })
    return
  }
  if (route === '/rpc' && request.method === 'POST') {
    const input = await readJson(request)
    const handler = handlers.get(String(input.channel ?? ''))
    if (!handler) {
      sendJson(response, 404, { ok: false, error: `未知功能：${String(input.channel ?? '')}` })
      return
    }
    const result = await handler(...(Array.isArray(input.args) ? input.args : []))
    sendJson(response, 200, { ok: true, result })
    return
  }
  sendJson(response, 404, { ok: false, error: '找不到本地接口' })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const port = Number(args[args.indexOf('--port') + 1])
  const token = args[args.indexOf('--token') + 1]
  if (!Number.isInteger(port) || !token) throw new Error('sidecar 缺少启动参数')

  registerHandlers()
  const settings = await getSettings()
  await applyProxyMode(settings.useSystemProxy)
  await hydrate()
  await ensureBundledSources()

  const server = createServer((request, response) => {
    void handleRequest(request, response, token).catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : '后台服务失败' })
      else response.destroy()
    })
  })
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`)
  })

  const shutdown = (): void => {
    closeMediaProxy()
    void flushStore().finally(() => server.close())
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
