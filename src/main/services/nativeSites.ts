import * as cheerio from 'cheerio'
import type { Episode, Line, Site, Vod, VodDetail } from '@shared/types'
import { matchesFullSearchKeyword } from '@shared/searchMatch'
import { fetchText, networkFetch, parseLooseJson } from './http'
import { requestCz4kBrowserPage } from '../../tauri/platform'

const NOMI_ORIGIN = 'https://vip.wwgz.cn:5200'
const NOMI_NBY_API = 'https://api.nbyjson.top:7788/api/'
const NOMI_NBY_KEY = 'tviKuMb3MlqCW1I6gE'
const IKANBOT_ORIGIN = 'https://www1.ikanbot.com'
const CZ4K_ORIGIN = 'https://www.cz4k.com'
const IKANBOT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36'
const NOMI_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'
const cookies = new Map<string, Map<string, string>>()
const ikanbotBootstrapped = new Set<string>()

function firstText(...values: Array<string | undefined>): string {
  return values.map((value) => value?.replace(/\s+/g, ' ').trim() ?? '').find(Boolean) ?? ''
}

function absolute(value: string, base: string): string {
  if (!value) return ''
  try { return new URL(value, base).href } catch { return value }
}

function sourceOrigin(site: Site): string {
  if (site.key === 'fan_nomi') return NOMI_ORIGIN
  if (site.key === 'ikanbot') return new URL(site.api || IKANBOT_ORIGIN).origin
  if (site.key === 'cz4k') return new URL(site.api || CZ4K_ORIGIN).origin
  throw new Error('该站点没有原生适配器')
}

function makeVod(site: Site, id: string, name: string, pic = '', remarks = '', year = '', area = '', content = ''): Vod {
  return {
    vod_id: id,
    vod_name: name,
    vod_pic: absolute(pic, sourceOrigin(site)),
    vod_remarks: remarks,
    vod_year: year,
    vod_area: area,
    vod_actor: '',
    vod_director: '',
    type_name: '',
    vod_score: '',
    siteKey: site.key,
    siteName: site.name,
    sourceId: site.sourceId,
    ...(content ? { vod_content: content } : {})
  }
}

function cleanNomiTitle(value: string): string {
  let name = value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  const categories = ['国产剧', '国产电影', '国产综艺', '国产动漫', '电视剧', '电影', '综艺', '动漫', '短剧']
  let changed = true
  while (changed && name) {
    changed = false
    for (const category of categories) {
      if (name.startsWith(category)) { name = name.slice(category.length).trim(); changed = true }
      if (name.endsWith(category)) { name = name.slice(0, -category.length).trim(); changed = true }
    }
    name = name.replace(/^[\s\-_|:/：]+|[\s\-_|:/：]+$/g, '').trim()
  }
  return name
}

function nomiTitle(...values: Array<string | undefined>): string {
  for (const value of values) {
    const title = cleanNomiTitle(value ?? '')
    if (title && !title.startsWith('/') && !/^https?:\/\//i.test(title) &&
      !/vod-detail|^(立即播放|播放|详情|查看|点击播放|下载|在线观看|查看详情)$/.test(title)) return title
  }
  return ''
}

function nomiMetadata(card: cheerio.Cheerio<any>, selector: string, attribute: string, pattern: RegExp): string {
  const nodes = card.find(selector)
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes.eq(index)
    const match = pattern.exec(firstText(node.attr(attribute), node.text()))
    if (match) return match[0]
  }
  const match = pattern.exec(card.text())
  return match ? match[0] : ''
}

function nomiSearch(site: Site, html: string, keyword: string, limit: number): Vod[] {
  const $ = cheerio.load(html)
  const found: Vod[] = []
  const seen = new Set<string>()
  $('a[href*="vod-detail"]').each((_index, element) => {
    const link = $(element)
    const id = absolute(link.attr('href') ?? '', NOMI_ORIGIN)
    if (!id || seen.has(id)) return
    const card = link.closest('li,article,.item,.module,.module-item,.video-item,.search-item,.vodlist_item,.vodlist,[class*=item]')
    const scope = card.length ? card : link.parent()
    const image = link.find('img').first().length ? link.find('img').first() : scope.find('img').first()
    const name = nomiTitle(
      scope.find('h1.title,h2.title,h3.title,h4.title,.sTit,[class*=vod-name],[class*=video-name]').first().text(),
      scope.find('h1,h2,h3,h4,[class*=title],[class*=name]')
        .filter((_i, node) => !$(node).hasClass('type-title')).first().text(),
      image.attr('alt'), image.attr('title'), link.attr('title'), link.text(), scope.text()
    )
    if (!name || !matchesFullSearchKeyword(name, keyword)) return
    seen.add(id)
    found.push(makeVod(
      site, id, name,
      firstText(image.attr('data-original'), image.attr('data-src'), image.attr('src')),
      nomiMetadata(scope, '[data-remarks],[class*=remarks],[class*=note],[class*=episode],[class*=update],[class*=status]', 'data-remarks', /(?:全\s*\d+\s*集|共\s*\d+\s*集|更新至\s*\d+\s*集|更新到\s*\d+\s*集|已完结|完结|全集|连载|更新中)/),
      nomiMetadata(scope, '[data-year],[class*=year]', 'data-year', /(?:19|20)\d{2}/),
      nomiMetadata(scope, '[data-area],[class*=area],[class*=region]', 'data-area', /中国大陆|中国香港|中国台湾|中国澳门|大陆|内地|香港|台湾|澳门|日本|韩国|美国|英国|泰国|印度|法国|德国|加拿大|澳大利亚|新加坡|马来西亚|俄罗斯|意大利|西班牙/)
    ))
  })
  return found.slice(0, limit)
}

function finishDetail(vod: Vod, lines: Line[], content = ''): VodDetail {
  return { ...vod, vod_content: content, lines }
}

function nomiDetail(site: Site, id: string, html: string): VodDetail {
  const $ = cheerio.load(html)
  const name = nomiTitle($('.title').not('.type-title').first().text(), $('h1:not(.type-title)').first().text(),
    $('#video_title').text(), $('meta[property="og:title"]').attr('content')) || id
  const image = firstText($('meta[property="og:image"]').attr('content'), $('img[src]').first().attr('src'))
  const text = $('body').text().replace(/\s+/g, ' ').trim()
  const vod = makeVod(site, id, name, image, '', (/(?:19|20)\d{2}/.exec(text) ?? [''])[0], '', text)
  let lists = $('#leftTabBox .numList')
  if (!lists.length) lists = $('.numList')
  if (!lists.length) lists = $('body')
  const routeTabs = $('#leftTabBox ul li').filter((_index, element) => !$(element).closest('.numList').length)
  const lines: Line[] = []
  lists.each((lineIndex, element) => {
    const links = $(element).find('a[href*="vod-play"]').toArray().reverse()
    const episodes: Episode[] = []
    const seen = new Set<string>()
    for (const linkElement of links) {
      const link = $(linkElement)
      const url = absolute(link.attr('href') ?? '', NOMI_ORIGIN)
      if (!url || seen.has(url)) continue
      seen.add(url)
      const rawName = firstText(link.text(), link.attr('title'))
      const name = rawName.replace(/^《[^》]+》\s*/, '').replace(/第\s*第\s*(\d+)\s*集\s*集/g, '第$1集')
        .replace(/\s*(?:在线播放|在线观看).*$/g, '').trim()
      episodes.push({ name: name && !/^(?:立即播放|播放|详情)$/i.test(name) ? name : `第${episodes.length + 1}集`, url, index: episodes.length })
    }
    if (episodes.length) {
      const route = $(element)
      const label = firstText(routeTabs.eq(lineIndex).attr('title'), routeTabs.eq(lineIndex).text(), route.attr('data-from'), route.attr('title'))
      lines.push({ name: label || `线路${lineIndex + 1}`, episodes })
    }
  })
  if (!lines.length) lines.push({ name: '线路1', episodes: [{ name: '播放页', url: id, index: 0 }] })
  return finishDetail(vod, lines, text)
}

async function fetchIkanbot(url: string, referer = `${IKANBOT_ORIGIN}/`): Promise<string> {
  const target = new URL(url)
  const jar = cookies.get(target.host) ?? new Map<string, string>()
  cookies.set(target.host, jar)
  const request = async (requestUrl: string, requestReferer: string): Promise<Response> => {
    const requestTarget = new URL(requestUrl)
    const requestIsApi = requestTarget.pathname.startsWith('/api/')
    const requestJar = cookies.get(requestTarget.host) ?? new Map<string, string>()
    cookies.set(requestTarget.host, requestJar)
    const headers: Record<string, string> = {
      'User-Agent': IKANBOT_UA,
      Accept: requestIsApi ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Referer: requestReferer,
      'Sec-Fetch-Dest': requestIsApi ? 'empty' : 'document',
      'Sec-Fetch-Mode': requestIsApi ? 'cors' : 'navigate',
      'Sec-Fetch-Site': 'same-origin'
    }
    if (requestIsApi) {
      headers.Origin = requestTarget.origin
      headers['X-Requested-With'] = 'XMLHttpRequest'
    }
    const cookie = [...requestJar].map(([name, value]) => `${name}=${value}`).join('; ')
    if (cookie) headers.Cookie = cookie
    return networkFetch(requestUrl, {
      headers,
      credentials: 'include',
      signal: AbortSignal.timeout(25000)
    })
  }
  const saveCookies = (response: Response, host: string): boolean => {
    const targetJar = cookies.get(host) ?? new Map<string, string>()
    cookies.set(host, targetJar)
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
    let changed = false
    for (const value of getSetCookie?.call(response.headers) ?? []) {
      const part = value.split(';', 1)[0]
      const split = part.indexOf('=')
      if (split > 0 && targetJar.get(part.slice(0, split)) !== part.slice(split + 1)) {
        targetJar.set(part.slice(0, split), part.slice(split + 1))
        changed = true
      }
    }
    return changed
  }

  let response = await request(url, referer)
  saveCookies(response, target.host)
  if (response.status === 403 && !ikanbotBootstrapped.has(target.host) && target.pathname !== '/') {
    ikanbotBootstrapped.add(target.host)
    const before = jar.size
    const warmup = await request(`${target.origin}/`, `${target.origin}/`)
    saveCookies(warmup, target.host)
    await warmup.body?.cancel()
    if (jar.size > before) {
      response = await request(url, referer)
      saveCookies(response, target.host)
    }
  }
  if (!response.ok) throw new Error(`爱看请求失败：HTTP ${response.status}`)
  return response.text()
}

function ikanbotSearch(site: Site, html: string, keyword: string, limit: number): Vod[] {
  const $ = cheerio.load(html)
  const result: Vod[] = []
  $('div.media').each((_index, element) => {
    const card = $(element)
    const link = card.find('a.cover-link[href^="/play/"]').first()
    const id = link.attr('href')?.match(/\/play\/([^/?#]+)/)?.[1] ?? ''
    if (!id) return
    const image = link.find('img').first()
    const meta = card.find('.media-body .small')
    result.push(makeVod(site, id,
      firstText(card.find('.title-text').first().text(), image.attr('alt'), link.attr('title')),
      firstText(image.attr('data-src'), image.attr('src')),
      '', '', meta.eq(0).text(), ''))
  })
  return result.filter((item) => item.vod_name && matchesFullSearchKeyword(item.vod_name, keyword)).slice(0, limit)
}

export async function browseIkanbotCategory(
  site: Site,
  typeId: string,
  page: number,
  limit: number
): Promise<{ list: Vod[]; hasNextPage: boolean }> {
  const type = typeId === '1' ? 'movie' : 'tv'
  const suffix = page > 1 ? `-p-${page}` : ''
  const url = new URL(`/hot/index-${type}-热门${suffix}.html`, sourceOrigin(site))
  const html = await fetchIkanbot(url.href, `${sourceOrigin(site)}/`)
  const $ = cheerio.load(html)
  const list: Vod[] = []
  $('.v-list .item a[href^="/play/"]').each((_index, element) => {
    const link = $(element)
    const id = link.attr('href')?.match(/\/play\/([^/?#]+)/)?.[1] ?? ''
    if (!id) return
    const image = link.find('img').first()
    const name = firstText(link.find('p').first().text(), image.attr('alt'), link.attr('title'))
    if (!name) return
    list.push(makeVod(
      site,
      id,
      name,
      firstText(image.attr('data-src'), image.attr('src')),
      '',
      (/(?:19|20)\d{2}/.exec(name) ?? [''])[0]
    ))
  })
  const hasNextPage = $('.page-more a').toArray().some((link) => $(link).text().trim() === '下一页')
  return { list: list.slice(0, limit), hasNextPage }
}

function ikanbotToken(id: string, eToken: string): string {
  if (id.length < 4 || eToken.length < 8) return ''
  let rest = eToken
  let token = ''
  for (const digit of id.slice(-4)) {
    const offset = Number(digit) % 3 + 1
    if (offset + 8 > rest.length) return ''
    token += rest.slice(offset, offset + 8)
    rest = rest.slice(offset + 8)
  }
  return token
}

function ikanbotLines(payload: unknown): Line[] {
  const root = payload as Record<string, any>
  if (Number(root?.state) !== 1) return []
  const raw = Array.isArray(root?.data?.list) ? root.data.list : []
  const lines: Line[] = []
  for (let sourceIndex = 0; sourceIndex < raw.length; sourceIndex++) {
    const source = raw[sourceIndex] as Record<string, any>
    let resources: unknown
    try { resources = typeof source.resData === 'string' ? parseLooseJson(source.resData) : source.resData } catch { continue }
    if (!Array.isArray(resources)) continue
    for (const resource of resources as Array<Record<string, any>>) {
      const episodes: Episode[] = []
      for (const entry of String(resource.url ?? '').split('#')) {
        const separator = entry.indexOf('$')
        if (separator <= 0) continue
        const name = entry.slice(0, separator).trim()
        const url = entry.slice(separator + 1).trim()
        if (!/^https?:\/\//i.test(url) || !/\.m3u8(?:[?#]|$)/i.test(url)) continue
        episodes.push({ name: name || `第${episodes.length + 1}集`, url, index: episodes.length })
      }
      if (episodes.length) lines.push({ name: String(resource.flag || `线路${sourceIndex + 1}`), episodes })
    }
  }
  return lines
}

async function ikanbotDetail(site: Site, id: string): Promise<VodDetail> {
  const detailUrl = new URL(`/play/${encodeURIComponent(id)}`, sourceOrigin(site)).href
  const $ = cheerio.load(await fetchIkanbot(detailUrl))
  const token = ikanbotToken(id, $('#e_token').attr('value') ?? '')
  const mtype = $('#mtype').attr('value') ?? ''
  let lines: Line[] = []
  if (token) {
    const api = new URL('/api/getResN', sourceOrigin(site))
    api.search = new URLSearchParams({ videoId: id, mtype, token }).toString()
    lines = ikanbotLines(parseLooseJson(await fetchIkanbot(api.href, detailUrl)))
  }
  const metas = $('#playList .detail .meta')
  const vod = makeVod(site, id,
    firstText($('#video_title').text(), $('title').text(), id),
    firstText($('#playList img.cover').attr('data-src'), $('#playList img.cover').attr('src')),
    '爱看机器人线路', metas.eq(2).text(), metas.eq(3).text(),
    firstText($('meta[name="description"]').attr('content'), $('#playList').text()))
  return finishDetail(vod, lines, firstText($('meta[name="description"]').attr('content'), $('#playList').text()))
}

interface Cz4kPage {
  html: string
  resourceUrls: string[]
}

async function fetchCz4kPage(url: string): Promise<Cz4kPage> {
  const target = new URL(url)
  if (target.hostname !== 'cz4k.com' && target.hostname !== 'www.cz4k.com') throw new Error('厂长请求地址不属于 cz4k.com')
  try {
    const page = await requestCz4kBrowserPage(target.href, `${CZ4K_ORIGIN}/`)
    if (page.cookies) {
      const jar = cookies.get(target.host) ?? new Map<string, string>()
      cookies.set(target.host, jar)
      for (const pair of page.cookies.split(';')) {
        const separator = pair.indexOf('=')
        if (separator > 0) jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
      }
    }
    return { html: page.html, resourceUrls: page.resourceUrls }
  } catch (error) {
    throw new Error(`厂长 WebView2 会话失败：${(error as Error).message}`)
  }
}

async function fetchCz4k(url: string): Promise<string> {
  return (await fetchCz4kPage(url)).html
}

function cz4kSearch(site: Site, html: string, keyword: string, limit: number): Vod[] {
  const $ = cheerio.load(html)
  const output: Vod[] = []
  const seen = new Set<string>()
  $('a[href]').each((_index, element) => {
    const link = $(element)
    const href = link.attr('href') ?? ''
    if (!/\.html(?:[?#]|$)|\/detail\/|\/voddetail\//i.test(href) || /\/search|\/nimasile|\/type|\/play|\/player/i.test(href)) return
    const card = link.closest('.module-item,li,article,[class*=item],[class*=vod]')
    const image = link.find('img').first().length ? link.find('img').first() : card.find('img').first()
    const name = firstText(link.attr('title'), image.attr('alt'), card.find('h1,h2,h3,h4,.title,.name,[class*=title]').first().text(), link.text())
    const id = absolute(href, CZ4K_ORIGIN)
    if (!name || !matchesFullSearchKeyword(name, keyword) || !id || seen.has(id) || name === keyword && !image.attr('src')) return
    seen.add(id)
    output.push(makeVod(site, id, name, firstText(image.attr('data-original'), image.attr('data-src'), image.attr('src')),
      card.find('.module-item-note,.pic-text,.remarks').first().text()))
  })
  return output.slice(0, limit)
}

async function cz4kDetail(site: Site, id: string): Promise<VodDetail> {
  const url = absolute(id, CZ4K_ORIGIN)
  const $ = cheerio.load(await fetchCz4k(url))
  const name = firstText($('h1').first().text(), $('.module-info-heading').first().text(), $('title').text(), id)
  const vod = makeVod(site, id,
    name.replace(/\s*[-|｜].*$/, '').trim(),
    firstText($('meta[property="og:image"]').attr('content'), $('.module-info-poster img').attr('data-original'), $('.module-info-poster img').attr('src')),
    '', '', '', firstText($('.module-info-content').text(), $('meta[name="description"]').attr('content')))
  const links = $('a[href]').toArray().filter((element) => /\/(?:v_play|p|play|player|vodplay)(?:\/|[?#])|\.m3u8(?:[?#]|$)/i.test($(element).attr('href') ?? ''))
  const episodes = links.map((element, index) => ({
    name: /立即播放/i.test($(element).text()) ? '正片'
      : firstText($(element).attr('title'), $(element).text()).replace(/\s*\([^)]*\)\s*$/, '').trim() || `第${index + 1}集`,
    url: absolute($(element).attr('href') ?? '', url),
    index
  })).filter((episode) => episode.url)
  const unique = episodes.filter((episode, index) => episodes.findIndex((item) => item.url === episode.url) === index)
  const lines = unique.length ? [{ name: '厂长线路', episodes: unique }] : []
  return finishDetail(vod, lines, firstText($('.module-info-content').text(), $('meta[name="description"]').attr('content')))
}

export function isNativeAdaptedSite(key: string): boolean {
  return key === 'fan_nomi' || key === 'ikanbot' || key === 'cz4k'
}

export async function searchNativeSite(site: Site, keyword: string, limit: number): Promise<Vod[]> {
  const origin = sourceOrigin(site)
  if (site.key === 'ikanbot') {
    const url = new URL('/search', origin)
    url.searchParams.set('q', keyword)
    return ikanbotSearch(site, await fetchIkanbot(url.href), keyword, limit)
  }
  if (site.key === 'fan_nomi') {
    const url = new URL('/index.php?m=vod-search', origin)
    const header = {
      ...(site.header ?? {}),
      'User-Agent': NOMI_UA,
      Referer: `${origin}/`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    }
    return nomiSearch(site, await fetchText(url.href, {
      method: 'POST',
      body: new URLSearchParams({ wd: keyword }),
      header,
      timeout: site.timeout ?? 15
    }), keyword, limit)
  }
  const url = new URL('/nimasile', origin)
  url.searchParams.set('q', keyword)
  return cz4kSearch(site, await fetchCz4k(url.href), keyword, limit)
}

export async function getNativeSiteDetail(site: Site, id: string): Promise<VodDetail> {
  if (site.key === 'ikanbot') return ikanbotDetail(site, id)
  if (site.key === 'fan_nomi') {
    const url = absolute(id, sourceOrigin(site))
    const header = { ...(site.header ?? {}), 'User-Agent': NOMI_UA }
    return nomiDetail(site, url, await fetchText(url, { header, timeout: site.timeout ?? 15 }))
  }
  return cz4kDetail(site, id)
}

export async function resolveCz4kEpisode(url: string): Promise<string> {
  if (isCz4kMediaUrl(url)) return url
  const queryMedia = mediaFromCz4kPlayerUrl(url)
  if (queryMedia) return queryMedia
  const page = await fetchCz4kPage(url)
  const html = page.html
  const decoded = html.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/').replace(/&amp;/g, '&')
  const $ = cheerio.load(html)
  const playerUrls = $('iframe[src],video[src],video source[src],source[src]')
    .toArray()
    .map((element) => absolute($(element).attr('src') ?? '', url))
  for (const playerUrl of playerUrls) {
    const media = mediaFromCz4kPlayerUrl(playerUrl)
    if (media) return media
  }
  const networkMedia = page.resourceUrls.find((candidate) =>
    /\.(?:m3u8|mp4|mpd)(?:$|[?#])/i.test(candidate) && !isLikelyImageHost(candidate)
  )
  if (networkMedia) return networkMedia
  const mediaCandidates = [...decoded.matchAll(/https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4|mpd)(?:\?[^\s"'<>\\]*)?/ig)]
    .map((match) => match[0])
  const playable = mediaCandidates.find((candidate) => !isLikelyImageHost(candidate)) ?? mediaCandidates[0]
  if (playable) return playable
  const embedded = firstText($('video source[src]').attr('src'), $('video[src]').attr('src'))
  return embedded ? absolute(embedded, url) : url
}

function isCz4kMediaUrl(value: string): boolean {
  return /^https?:\/\/[^/?#]+\/[^\s"'<>]*\.(?:m3u8|mp4|mpd)(?:[?#]|$)/i.test(value)
}

function isLikelyImageHost(value: string): boolean {
  try {
    return /^(?:img|image|pic|poster|static)(?:\d*|[-.])/i.test(new URL(value).hostname)
  } catch {
    return false
  }
}

function decodedPlayerValues(value: string): string[] {
  const values = new Set<string>()
  let current = value.trim().replace(/^['"]|['"]$/g, '')
  for (let depth = 0; depth < 4 && current; depth++) {
    current = current.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/').replace(/&amp;/g, '&')
    values.add(current)
    try {
      const decoded = decodeURIComponent(current)
      if (decoded !== current) {
        current = decoded
        continue
      }
    } catch {
      // The value may contain a literal percent sign rather than URL encoding.
    }
    if (!/^https?:\/\//i.test(current) && /^[A-Za-z0-9_+/=-]{24,}$/.test(current)) {
      const base64 = Buffer.from(current.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim()
      if (/^https?:\/\//i.test(base64)) {
        current = base64
        continue
      }
    }
    break
  }
  return [...values]
}

function mediaFromCz4kPlayerUrl(rawUrl: string, depth = 0): string {
  if (depth > 2) return ''
  let playerUrl: URL
  try { playerUrl = new URL(rawUrl, CZ4K_ORIGIN) } catch { return '' }
  if (!/\/py\.php$/i.test(playerUrl.pathname)) return ''
  const parameterNames = new Set(['url', 'playurl', 'play_url', 'm3u8', 'src', 'file', 'video', 'v'])
  const values = [...playerUrl.searchParams.entries()]
    .filter(([name]) => parameterNames.has(name.toLowerCase()))
    .map(([, value]) => value)
  for (const value of values) {
    for (const candidate of decodedPlayerValues(value)) {
      const absoluteCandidate = absolute(candidate, playerUrl.href)
      if (isCz4kMediaUrl(absoluteCandidate)) return absoluteCandidate
      if (/^https?:\/\//i.test(candidate)) {
        const nested = mediaFromCz4kPlayerUrl(candidate, depth + 1)
        if (nested) return nested
      }
    }
  }
  return ''
}

export async function resolveNomiEpisode(url: string, site: Site): Promise<string> {
  if (/^https?:\/\/[^/?#]+\/.*\.(?:m3u8|mp4|mpd|flv)(?:[?#]|$)/i.test(url)) return url
  const pageUrl = absolute(url, sourceOrigin(site))
  const headers = { ...(site.header ?? {}), 'User-Agent': NOMI_UA, Referer: `${NOMI_ORIGIN}/` }
  const html = await fetchText(pageUrl, { header: headers, timeout: site.timeout ?? 20 })
  const raw = /\bmac_url\s*=\s*(['"])([\s\S]*?)\1/i.exec(html)?.[2]
    ?.replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&') ?? ''
  const entries = raw.split('$$$').filter(Boolean)
  const sourceIndex = Math.max(0, (Number(/-src-(\d+)-num-/i.exec(pageUrl)?.[1]) || 1) - 1)
  const ordered = [entries[sourceIndex], ...entries.filter((_entry, index) => index !== sourceIndex)].filter(Boolean)
  const candidates: string[] = []
  for (const entry of ordered) {
    const separator = entry.indexOf('$')
    const value = (separator >= 0 ? entry.slice(separator + 1) : entry).trim()
    if (/^NBY-/i.test(value)) {
      const api = new URL(NOMI_NBY_API)
      api.searchParams.set('key', NOMI_NBY_KEY)
      api.searchParams.set('url', value)
      const payload = parseLooseJson(await fetchText(api.href, { header: { 'User-Agent': 'okhttp-okgo/jeasonlzy' }, timeout: 20 })) as Record<string, unknown>
      const media = String(payload.url ?? payload.m3u8 ?? '').trim()
      if (/^https?:\/\//i.test(media)) candidates.push(media)
      continue
    }
    if (/^https?:\/\/[^\s'"<>]+\.(?:m3u8|mp4|mpd|flv)(?:[?#][^\s'"<>]*)?$/i.test(value)) candidates.push(value)
  }
  const probeHeaders = { ...headers, Referer: pageUrl }
  const isPlayable = async (mediaUrl: string): Promise<boolean> => {
    let current = mediaUrl
    for (let depth = 0; depth < 4; depth++) {
      if (!/\.m3u8(?:$|[?#])/i.test(current)) {
        const check = await networkFetch(current, {
          headers: { ...probeHeaders, Range: 'bytes=0-0' },
          signal: AbortSignal.timeout(8000)
        })
        const playable = check.ok && !/text\/html/i.test(check.headers.get('content-type') ?? '')
        await check.body?.cancel()
        return playable
      }
      const response = await networkFetch(current, { headers: probeHeaders, signal: AbortSignal.timeout(8000) })
      if (!response.ok) return false
      const body = await response.text()
      if (!body.includes('#EXTM3U')) return !/text\/html/i.test(response.headers.get('content-type') ?? '')
      const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const streamIndex = lines.findIndex((line) => /^#EXT-X-STREAM-INF:/i.test(line))
      if (streamIndex >= 0) {
        const variant = lines.slice(streamIndex + 1).find((line) => !line.startsWith('#'))
        if (!variant) return false
        current = new URL(variant, response.url || current).href
        continue
      }
      const segment = lines.find((line) => !line.startsWith('#'))
      if (!segment) return false
      const check = await networkFetch(new URL(segment, response.url || current), {
        headers: { ...probeHeaders, Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(8000)
      })
      const playable = check.ok && !/text\/html/i.test(check.headers.get('content-type') ?? '')
      await check.body?.cancel()
      return playable
    }
    return false
  }
  for (const candidate of [...new Set(candidates)].slice(0, 4)) {
    try {
      if (await isPlayable(candidate)) return candidate
    } catch {
      // Try the next route published on the Nomi playback page.
    }
  }
  throw new Error(candidates.length ? '糯米线路的媒体分片当前不可访问' : '糯米播放页没有可用媒体地址')
}
