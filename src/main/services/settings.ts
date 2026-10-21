import type { AppSettings } from '@shared/types'
import { DEFAULT_UA } from './http'
import { readStore, writeStore } from './store'

const NAME = 'settings'
const HOME_SOURCE_KEYS = new Set(['guazi', 'xgzy', 'dyttzy', 'ffzy', 'lzi', 'bfzy'])

export const DEFAULT_SETTINGS: AppSettings = {
  settingsVersion: 6,
  concurrency: 10,
  language: 'zh-CN',
  timeout: 3,
  singleSourceTimeoutSeconds: 2,
  useSystemProxy: false,
  userAgent: DEFAULT_UA,
  theme: 'light',
  accent: '#6A3DE8',
  density: 'compact',
  sidebarCollapsed: false,
  homeSourceKey: 'guazi',
  filterCommentary: false,
  m3u8Purify: true,
  danmakuEnabled: true,
  fullscreenSystemTimeEnabled: true,
  fullscreenPlaybackTimeEnabled: true,
  danmakuMaxLines: 3,
  danmakuSpeed: 1,
  danmakuSize: 1.2,
  danmakuOpacity: 0.9,
  danmakuRandomColor: true,
  introSkipSeconds: 0,
  outroSkipSeconds: 0,
  externalPlayer: { command: '', args: ['{url}'], prefer: ['PotPlayer', 'mpv', 'VLC'] },
  window: { width: 1440, height: 900 },
  // API Key 默认留空：没填之前「AI 总结本集」按钮会提示去设置页填
  ai: { apiKey: '', model: 'deepseek-flash', baseUrl: '' }
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await readStore<Partial<AppSettings> & { filterAdult?: boolean }>(NAME, {})
  const { filterAdult: legacyFilterAdult, ...storedSettings } = stored
  const storedHomeSourceKey = String(stored.homeSourceKey ?? '')
  const homeSourceKey = HOME_SOURCE_KEYS.has(storedHomeSourceKey)
    ? storedHomeSourceKey as AppSettings['homeSourceKey']
    : DEFAULT_SETTINGS.homeSourceKey
  const needsHomeSourceMigration = stored.homeSourceKey !== undefined && storedHomeSourceKey !== homeSourceKey
  const storedVersion = stored.settingsVersion ?? 0
  const needsMigration = storedVersion < 6
  const storedConcurrency = Number(stored.concurrency)
  const storedTimeout = Number(stored.timeout)
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...storedSettings,
    settingsVersion: 6,
    homeSourceKey,
    concurrency: storedVersion < 3 && stored.concurrency === 8
      ? 10
      : Number.isFinite(storedConcurrency)
        ? Math.max(1, Math.min(32, Math.trunc(storedConcurrency)))
        : DEFAULT_SETTINGS.concurrency,
    language: stored.language === 'en-US' ? 'en-US' : 'zh-CN',
    timeout: storedVersion < 1 && stored.timeout === 20
      ? 3
      : Number.isFinite(storedTimeout)
        ? Math.max(3, Math.min(120, Math.trunc(storedTimeout)))
        : DEFAULT_SETTINGS.timeout,
    singleSourceTimeoutSeconds: Number.isFinite(stored.singleSourceTimeoutSeconds)
      ? Math.max(1, Math.min(10, Math.trunc(stored.singleSourceTimeoutSeconds ?? DEFAULT_SETTINGS.singleSourceTimeoutSeconds)))
      : DEFAULT_SETTINGS.singleSourceTimeoutSeconds,
    filterCommentary: stored.filterCommentary ?? DEFAULT_SETTINGS.filterCommentary,
    externalPlayer: { ...DEFAULT_SETTINGS.externalPlayer, ...(stored.externalPlayer ?? {}) },
    window: { ...DEFAULT_SETTINGS.window, ...(stored.window ?? {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(stored.ai ?? {}) }
  }
  if (needsMigration || needsHomeSourceMigration || legacyFilterAdult !== undefined) writeStore(NAME, settings)
  return settings
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...patch }
  writeStore(NAME, next)
  return next
}
