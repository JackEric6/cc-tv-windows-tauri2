import type { AppSettings } from '@shared/types'
import { DEFAULT_UA } from './http'
import { readStore, writeStore } from './store'

const NAME = 'settings'

export const DEFAULT_SETTINGS: AppSettings = {
  settingsVersion: 4,
  concurrency: 10,
  language: 'zh-CN',
  timeout: 3,
  singleSourceTimeoutSeconds: 2,
  useSystemProxy: false,
  userAgent: DEFAULT_UA,
  theme: 'light',
  accent: '#2563EB',
  density: 'compact',
  sidebarCollapsed: false,
  homeSourceKey: 'guazi',
  // 采集站里「XX解说 / 一口气看完」这类二创短片和正片同名同封面，默认挡掉
  filterCommentary: true,
  filterAdult: true,
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
  const stored = await readStore<Partial<AppSettings>>(NAME, {})
  const storedVersion = stored.settingsVersion ?? 0
  const needsMigration = storedVersion < 4
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    settingsVersion: 4,
    concurrency: storedVersion < 3 && stored.concurrency === 8 ? 10 : stored.concurrency ?? DEFAULT_SETTINGS.concurrency,
    language: stored.language === 'en-US' ? 'en-US' : 'zh-CN',
    timeout: storedVersion < 1 && stored.timeout === 20 ? 3 : stored.timeout ?? DEFAULT_SETTINGS.timeout,
    singleSourceTimeoutSeconds: Number.isFinite(stored.singleSourceTimeoutSeconds)
      ? Math.max(1, Math.min(10, Math.trunc(stored.singleSourceTimeoutSeconds ?? DEFAULT_SETTINGS.singleSourceTimeoutSeconds)))
      : DEFAULT_SETTINGS.singleSourceTimeoutSeconds,
    filterAdult: true,
    externalPlayer: { ...DEFAULT_SETTINGS.externalPlayer, ...(stored.externalPlayer ?? {}) },
    window: { ...DEFAULT_SETTINGS.window, ...(stored.window ?? {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(stored.ai ?? {}) }
  }
  if (needsMigration || stored.filterAdult !== true) writeStore(NAME, settings)
  return settings
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...patch, filterAdult: true }
  writeStore(NAME, next)
  return next
}
