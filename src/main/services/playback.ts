import type { PlayerResolved } from '@shared/types'
import { resolveCongcongEpisode } from './congcongSources'
import { getSettings } from './settings'
import { getSite, resolveHeader } from './sites'
import { cmsRefererForApi } from './cms'
import { prepareMediaUrl } from './mediaProxy'
import { resolvePlayUrl } from './parse'
import { resolveCz4kEpisode, resolveNomiEpisode } from './nativeSites'

const M3U8_PURIFY_EXEMPT_SOURCES = new Set(['guazi'])

export function shouldPurifyM3u8(siteKey: string, enabled: boolean): boolean {
  return enabled && !M3U8_PURIFY_EXEMPT_SOURCES.has(siteKey.toLowerCase())
}

function isDirect(url: string): boolean {
  return /^https?:\/\//i.test(url) && /\.(m3u8|mp4|flv|mkv|ts|mov|avi|webm|m4v|mpd|mp3|m4a)(?:[?#]|$)/i.test(url)
}

async function prepare(url: string, headers: Record<string, string>, purify: boolean): Promise<string> {
  return prepareMediaUrl(url, headers, purify)
}

export async function resolvePlaybackHeaders(siteKey: string, sourceUrl: string, pageReferer = ''): Promise<Record<string, string>> {
  const site = await getSite(siteKey)
  const headers = site ? await resolveHeader(site, sourceUrl) : {}
  const hasReferer = (): boolean => Object.keys(headers).some((key) => key.toLowerCase() === 'referer')
  const setReferer = (value: string): void => {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'referer') delete headers[key]
    }
    headers.Referer = value
  }
  if (siteKey.toLowerCase() === 'fan_nomi' && site) {
    headers['User-Agent'] = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'
    setReferer(pageReferer || `${new URL(site.api).origin}/`)
  }
  if (siteKey.toLowerCase() === 'ikanbot' && site) {
    headers['User-Agent'] = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'
    setReferer(`${new URL(site.api).origin}/`)
  }
  if (siteKey.toLowerCase() === 'jianpian') {
    headers['User-Agent'] = 'Mozilla/5.0 packageName:com.jp3.xg3'
    headers.Accept = '*/*'
    setReferer('https://fan123.hzhnl.com/')
  }
  if (siteKey.toLowerCase() === 'cz4k') setReferer('https://www.cz4k.com/')
  if (siteKey.toLowerCase() === 'xgzy') setReferer('https://caiji.xgzyapi.com/')
  if (siteKey.toLowerCase() === 'guazi') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'user-agent') delete headers[key]
    }
    headers['User-Agent'] = 'KSPlayer'
  }
  if (site && siteKey.toLowerCase() !== 'guazi' && !hasReferer()) {
    let referer = cmsRefererForApi(site.api)
    if (!referer) {
      try {
        const origin = new URL(site.api).origin
        if (!/^https?:\/\/localhost(?::|$)|^https?:\/\/127\./i.test(origin)) referer = `${origin}/`
      } catch {
        // The source may use an app-local adapter URL rather than an upstream origin.
      }
    }
    if (referer) setReferer(referer)
  }
  return headers
}

export async function resolveEpisodeForPlayer(siteKey: string, rawUrl: string): Promise<PlayerResolved> {
  if (!rawUrl.trim()) throw new Error('缺少播放地址')
  let sourceUrl = await resolveCongcongEpisode(siteKey, rawUrl)
  const site = await getSite(siteKey)
  if (siteKey.toLowerCase() === 'fan_nomi' && site) sourceUrl = await resolveNomiEpisode(sourceUrl, site)
  if (siteKey === 'cz4k' && !isDirect(sourceUrl)) sourceUrl = await resolveCz4kEpisode(sourceUrl)
  let direct = isDirect(sourceUrl) || (siteKey.toLowerCase() === 'jianpian' && /^https?:\/\//i.test(sourceUrl))
  if (!direct) {
    const parsed = await resolvePlayUrl(sourceUrl)
    if (!parsed.ok || !parsed.url) throw new Error(parsed.error || '没能解析出可播放地址')
    sourceUrl = parsed.url
    direct = parsed.direct
  }
  const headers = await resolvePlaybackHeaders(siteKey, sourceUrl, siteKey.toLowerCase() === 'fan_nomi' ? rawUrl : '')
  const settings = await getSettings()
  const purifyEnabled = shouldPurifyM3u8(siteKey, settings.m3u8Purify)
  return {
    url: await prepare(sourceUrl, headers, purifyEnabled),
    sourceUrl,
    direct,
    purifyEnabled
  }
}
