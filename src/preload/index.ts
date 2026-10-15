import { contextBridge, initializeTauriIpc, ipcRenderer } from '../renderer/src/tauri/ipcShim'
import { IPC } from '@shared/ipc'
import type {
  AiFrame,
  AiSummaryInput,
  AiSummaryResult,
  AppInfo,
  AppSettings,
  CategoryBucket,
  CategoryPage,
  ConfigSource,
  SourcePresetInfo,
  FavoriteItem,
  HistoryItem,
  HomeSection,
  LibrarySnapshot,
  PlayerInfo,
  ParseInfo,
  ParseResult,
  ParseTestResult,
  DanmakuCandidate,
  DanmakuCue,
  OfflineTask,
  OfflineTaskInput,
  PlayerResolved,
  SearchOptions,
  SearchProgress,
  SearchResponse,
  Site,
  TestResult,
  VodDetail
} from '@shared/types'

const api = {
  info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.settingsSet, patch)
  },

  sources: {
    list: (): Promise<ConfigSource[]> => ipcRenderer.invoke(IPC.sourcesList),
    add: (input: { name?: string; url: string; kind?: 'url' | 'file' }): Promise<ConfigSource> =>
      ipcRenderer.invoke(IPC.sourcesAdd, input),
    update: (
      id: string,
      patch: Partial<Pick<ConfigSource, 'name' | 'url' | 'enabled'>>
    ): Promise<ConfigSource> => ipcRenderer.invoke(IPC.sourcesUpdate, id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sourcesRemove, id),
    sync: (id: string): Promise<ConfigSource> => ipcRenderer.invoke(IPC.sourcesSync, id),
    syncAll: (): Promise<ConfigSource[]> => ipcRenderer.invoke(IPC.sourcesSyncAll),
    pickFile: (): Promise<string | null> => ipcRenderer.invoke(IPC.sourcesPickFile),
    presets: (): Promise<SourcePresetInfo[]> => ipcRenderer.invoke(IPC.sourcesPresets),
    addPreset: (id: string): Promise<ConfigSource> => ipcRenderer.invoke(IPC.sourcesAddPreset, id)
  },

  sites: {
    list: (): Promise<Site[]> => ipcRenderer.invoke(IPC.sitesList),
    setEnabled: (key: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.sitesSetEnabled, key, enabled),
    setAreaEnabled: (key: string, area: 'home' | 'search' | 'category', enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.sitesSetAreaEnabled, key, area, enabled),
    setAllEnabled: (keys: string[], enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.sitesSetAllEnabled, keys, enabled),
    test: (key: string): Promise<TestResult> => ipcRenderer.invoke(IPC.sitesTest, key)
  },

  search: {
    run: (wd: string, options?: SearchOptions): Promise<SearchResponse> =>
      ipcRenderer.invoke(IPC.searchRun, wd, options),
    suggest: (wd: string): Promise<string[]> => ipcRenderer.invoke(IPC.searchSuggest, wd),
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC.searchCancel),
    /** 订阅进度事件，返回取消订阅的函数 */
    onProgress: (cb: (progress: SearchProgress) => void): (() => void) => {
      const listener = (_e: unknown, progress: SearchProgress): void => cb(progress)
      ipcRenderer.on(IPC.searchProgress, listener)
      return () => {
        ipcRenderer.removeListener(IPC.searchProgress, listener)
      }
    }
  },

  detail: {
    get: (siteKey: string, vodId: string): Promise<VodDetail> =>
      ipcRenderer.invoke(IPC.detailGet, siteKey, vodId)
  },

  category: {
    list: (): Promise<CategoryBucket[]> => ipcRenderer.invoke(IPC.categoryList),
    browse: (bucket: string, sub = '', page = 1, siteKey?: string): Promise<CategoryPage> =>
      ipcRenderer.invoke(IPC.categoryBrowse, bucket, sub, page, siteKey)
  },

  home: {
    /** 首页内容位。force=true 时忽略 10 分钟缓存重新拉 */
    sections: (force = false): Promise<HomeSection[]> =>
      ipcRenderer.invoke(IPC.homeSections, force),
    expand: (sectionKey: string): Promise<HomeSection> =>
      ipcRenderer.invoke(IPC.homeSectionExpand, sectionKey)
  },

  library: {
    get: (): Promise<LibrarySnapshot> => ipcRenderer.invoke(IPC.libraryGet),
    toggleFavorite: (input: Omit<FavoriteItem, 'addedAt'>): Promise<{ favorited: boolean }> =>
      ipcRenderer.invoke(IPC.libraryToggleFavorite, input),
    removeFavorite: (key: string): Promise<void> =>
      ipcRenderer.invoke(IPC.libraryRemoveFavorite, key),
    clearFavorites: (): Promise<void> => ipcRenderer.invoke(IPC.libraryClearFavorites),
    record: (input: Omit<HistoryItem, 'updatedAt'>): Promise<void> =>
      ipcRenderer.invoke(IPC.libraryRecord, input),
    /** key 是归一化片名（HistoryGroup.key），会删掉这部片在所有源上的记录 */
    removeHistory: (key: string): Promise<void> => ipcRenderer.invoke(IPC.libraryRemoveHistory, key),
    clearHistory: (): Promise<void> => ipcRenderer.invoke(IPC.libraryClearHistory)
  },

  player: {
    detect: (): Promise<PlayerInfo[]> => ipcRenderer.invoke(IPC.playerDetect),
    open: (url: string, title: string): Promise<{ player: string; args: string[] }> =>
      ipcRenderer.invoke(IPC.playerOpen, url, title),
    resolveEpisode: (siteKey: string, url: string): Promise<PlayerResolved> =>
      ipcRenderer.invoke(IPC.playerResolveEpisode, siteKey, url),
  },

  danmaku: {
    search: (title: string, episode: string, requestId: string): Promise<DanmakuCandidate[]> =>
      ipcRenderer.invoke(IPC.danmakuSearch, title, episode, requestId),
    load: (id: string, requestId: string, cacheKey?: string): Promise<DanmakuCue[]> =>
      ipcRenderer.invoke(IPC.danmakuLoad, id, requestId, cacheKey),
    cancel: (requestId: string): Promise<void> => ipcRenderer.invoke(IPC.danmakuCancel, requestId)
  },

  offline: {
    list: (): Promise<OfflineTask[]> => ipcRenderer.invoke(IPC.offlineList),
    add: (input: OfflineTaskInput): Promise<OfflineTask> => ipcRenderer.invoke(IPC.offlineAdd, input),
    pause: (id: string): Promise<void> => ipcRenderer.invoke(IPC.offlinePause, id),
    retry: (id: string): Promise<void> => ipcRenderer.invoke(IPC.offlineRetry, id),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.offlineCancel, id),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.offlineDelete, id),
    play: (id: string): Promise<{ task: OfflineTask; url: string; posterUrl?: string; danmaku: DanmakuCue[] }> =>
      ipcRenderer.invoke(IPC.offlinePlay, id)
  },

  parse: {
    list: (): Promise<ParseInfo[]> => ipcRenderer.invoke(IPC.parseList),
    /** 网页型地址走解析换直链；直链会原样返回（direct=true） */
    resolve: (url: string, options?: { flag?: string; prefer?: string }): Promise<ParseResult> =>
      ipcRenderer.invoke(IPC.parseResolve, url, options ?? {}),
    test: (url: string, target?: string): Promise<ParseTestResult> =>
      ipcRenderer.invoke(IPC.parseTest, url, target),
    add: (input: {
      name?: string
      type?: number
      url: string
      flags?: string[]
    }): Promise<ParseInfo[]> => ipcRenderer.invoke(IPC.parseAdd, input),
    remove: (url: string): Promise<ParseInfo[]> => ipcRenderer.invoke(IPC.parseRemove, url),
    resetStats: (): Promise<ParseInfo[]> => ipcRenderer.invoke(IPC.parseResetStats)
  },

  ai: {
    summarize: (input: AiSummaryInput): Promise<AiSummaryResult> =>
      ipcRenderer.invoke(IPC.aiSummary, input),
    /** frames 是渲染进程从 <video> 抽的帧，走 IPC 传给主进程拼成多模态请求 */
    summarizeVisual: (input: AiSummaryInput, frames: AiFrame[]): Promise<AiSummaryResult> =>
      ipcRenderer.invoke(IPC.aiSummaryVisual, input, frames)
  }
}

export type DesktopApi = typeof api

contextBridge.exposeInMainWorld('api', api)

export const initializeDesktopRuntime = initializeTauriIpc
