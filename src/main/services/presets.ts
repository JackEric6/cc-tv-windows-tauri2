import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from '../../tauri/platform'
import congcongConfig from '../assets/congcong_sources.json'
import { isAndroidSource, isSearchableByDefault } from '@shared/searchSourcePolicy'
import type { ConfigSource, SourcePresetInfo } from '@shared/types'
import { addSource, listSources, syncSource } from './sources'
import { readStore, writeStore } from './store'

/** 记住「内置订阅已经送过了」，避免用户删光后重启又冒出来 */
const BUNDLED_FLAG = 'bundled-sources'

/**
 * 内置推荐订阅。
 *
 * 打包版走 `ensureBundledSources()`：装完直接就是「带源」状态，打开就能搜。
 * 设置页里仍然把它列出来，用户可以随时删掉，删干净了也不会自己长回来。
 *
 * 点「添加」时会把配置内容落到 <数据目录>/presets/<id>.json，
 * 而不是引用仓库里的 samples/，这样仓库删了、应用换台机器也能继续用。
 */
export interface SourcePreset {
  id: string
  name: string
  desc: string
  /** 给界面显示用：这个订阅里有几个站点 */
  siteCount: number
  config: {
    format: string
    name: string
    note: string
    sites: Record<string, unknown>[]
    parses?: Record<string, unknown>[]
    flags?: string[]
    headers?: Record<string, unknown>[]
    tvboxDesktop?: Record<string, unknown>
  }
}

const sourceConfig = congcongConfig as unknown as Record<string, any>
const GUAZI_HOME_SECTIONS = [
  ['74151', '10月重磅新剧', '4'],
  ['46296', '最新热播电影', '3'],
  ['19260', 'TC抢先看', '3'],
  ['17613', '豆瓣电影TOP250', '3'],
  ['130', 'Netflix新片推荐', '1'],
  ['10772', '入站必追?累计2亿追番', '5'],
  ['24058', '爱奇艺剧场', '4'],
  ['24066', '优酷剧场', '4'],
  ['24057', '腾讯剧场', '4'],
  ['24067', '芒果剧场', '4'],
  ['38579', '大厂VIP短剧专区', '16'],
  ['16560', '历届奥斯卡最佳影片', '3'],
  ['8', '冷门悬疑佳片Top20', '3'],
  ['6663', '近期热门综艺', '6']
]
const CONGCONG_SITES = [
  ...(Array.isArray(sourceConfig.sites) ? sourceConfig.sites : []).map((raw) => {
    const key = String(raw.key ?? '')
    const api = key === 'xgzy'
      ? 'https://caiji.xgzyapi.com/api.php/provide/vod/from/xiguam3u8/'
      : key === 'guazi'
        ? 'https://api.anctjd.com/App/Index/findMoreVod'
        : String(raw.api ?? '')
    const special = key === 'guazi'
    return {
      ...raw,
      enabled: raw.enabled ?? true,
      searchable: isSearchableByDefault(key) ? 1 : 0,
      type: special ? 4 : 3,
      filterable: special ? 0 : raw.filterable,
      api
    }
  }),
  { key: 'ikanbot', name: '爱看', type: 1, api: 'https://www1.ikanbot.com', searchable: 1, quickSearch: 1, filterable: 1, timeout: 25, enabled: true },
  { key: 'cz4k', name: '厂长', type: 1, api: 'https://www.cz4k.com', searchable: 0, quickSearch: 0, filterable: 0, timeout: 30, enabled: true },
  { key: 'fan_nomi', name: '糯米', type: 1, api: 'https://vip.wwgz.cn:5200', searchable: 1, quickSearch: 1, filterable: 0, timeout: 15, enabled: true }
]

const CONGCONG_PRESET: SourcePreset = {
  id: 'congcong-built-in',
  name: '丛丛影视内置源',
  desc: '内置丛丛影视源、公开采集接口，以及从 Android 1.0.74 迁移的专用适配源。',
  siteCount: CONGCONG_SITES.length,
  config: {
    format: 'tvbox-desktop/1',
    name: '丛丛影视内置源',
    note: '丛丛影视 Windows 内置影视源。',
    sites: CONGCONG_SITES,
    parses: Array.isArray(sourceConfig.parses) ? sourceConfig.parses : [],
    flags: Array.isArray(sourceConfig.flags) ? sourceConfig.flags : [],
    headers: Array.isArray(sourceConfig.headers) ? sourceConfig.headers : [],
    tvboxDesktop: {
      home: {
        sections: GUAZI_HOME_SECTIONS.map(([typeId, title, pid]) => ({ title, site: 'guazi', typeId, pid }))
      }
    }
  }
}

const PUBLIC_CMS: SourcePreset = {
  id: 'public-cms',
  name: '公开可用源（苹果CMS 采集站）',
  desc: '实测存活的 2 个公开采集接口。',
  siteCount: 2,
  config: {
    format: 'tvbox-desktop/1',
    name: '公开可用源（苹果CMS 采集站）',
    note: '实测存活的公开采集接口，全部是标准苹果CMS v10 的 /api.php/provide/vod。判断标准有三条：列表接口有数据、带 wd 的搜索有结果、详情能解析出剧集地址。',
    sites: [
      {
        key: 'dyttzy',
        name: '电影天堂资源',
        type: 'cms',
        api: 'https://caiji.dyttzyapi.com/api.php/provide/vod',
        searchable: 1,
        enabled: true
      },
      {
        key: 'subo',
        name: '素博',
        type: 'cms',
        api: 'https://subocaiji.com/api.php/provide/vod',
        searchable: isSearchableByDefault('subo') ? 1 : 0,
        enabled: true
      }
    ],
    // 首页内容位。写在这里的行优先于「每个源一条最近更新」的默认行为，
    // 让首启就有几行带分类的内容，而不是五条一模一样的「最近更新」。
    // typeId 用的是苹果CMS v10 的默认分类 id（6=动作片、13=国产剧、42=日本动漫），
    // 这五条都在真实源上逐条验证过 20 条有内容。
    tvboxDesktop: {
      home: {
        sections: [
          { title: '电影 · 最近更新', site: 'dyttzy' },
          { title: '电影 · 动作片', site: 'ffzy', typeId: 6 },
          { title: '电视剧 · 国产剧', site: 'lzi', typeId: 13 },
          { title: '动漫 · 日本', site: 'guangsu', typeId: 42 },
          { title: '综艺 · 最近更新', site: 'subo' }
        ]
      }
    }
  }
}

export const SOURCE_PRESETS: SourcePreset[] = [CONGCONG_PRESET, PUBLIC_CMS]

function normalizedSourceUrl(value: unknown): string {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

function mergeSites(existing: Record<string, unknown>[], additions: Record<string, unknown>[]): Record<string, unknown>[] {
  const result = existing.map((site) => ({ ...site }))
  const keys = new Set(result.map((site) => String(site.key ?? '')))
  const urls = new Set(result.map((site) => normalizedSourceUrl(site.api)))
  for (const source of additions) {
    const url = normalizedSourceUrl(source.api)
    if (!url || urls.has(url)) continue
    const originalKey = String(source.key ?? '')
    if (!originalKey) continue
    let key = originalKey
    let suffix = 1
    while (keys.has(key)) {
      key = `${originalKey}-public${suffix > 1 ? suffix : ''}`
      suffix++
    }
    result.push({
      ...source,
      key,
      ...(key === originalKey ? {} : { name: `${String(source.name ?? originalKey)}（公开接口）` })
    })
    keys.add(key)
    urls.add(url)
  }
  return result
}

CONGCONG_PRESET.config.sites = mergeSites(CONGCONG_PRESET.config.sites, PUBLIC_CMS.config.sites)
CONGCONG_PRESET.siteCount = CONGCONG_PRESET.config.sites.length
CONGCONG_PRESET.desc = `内置 ${CONGCONG_PRESET.siteCount} 个影视源，包含西瓜、瓜子、公开采集接口及 Android 1.0.74 迁移源。`

export function listPresets(): SourcePresetInfo[] {
  return SOURCE_PRESETS.map(({ id, name, desc, siteCount }) => ({
    id,
    name,
    desc,
    siteCount
  }))
}

/** 把预设落成数据目录里的一个本地配置文件，再注册成配置源 */
export async function addPreset(id: string): Promise<ConfigSource> {
  const preset = SOURCE_PRESETS.find((p) => p.id === id)
  if (!preset) throw new Error('没有这个内置订阅')

  const dir = join(app.getPath('userData'), 'presets')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${preset.id}.json`)
  writeFileSync(file, JSON.stringify(preset.config, null, 2), 'utf8')

  const existing = await listSources()
  const already = existing.find((s) => s.url === file)
  if (already) throw new Error('这个内置订阅已经添加过了')
  return addSource({ name: preset.name, url: file, kind: 'file' })
}

/**
 * 首启把内置订阅装好，让打包版「装完即用」。
 *
 * 只在一个配置源都没有的时候执行 —— 用户自己删光了就不该再冒出来。
 * 装上之后立刻同步一次，这样首屏的影视源就有数据，
 * 不用等用户手动点「同步配置」。
 *
 * 只带**订阅源**，不带设置：API Key、外部播放器路径、收藏与观看历史
 * 都属于使用者的个人数据，绝不能跟着安装包发出去。
 *
 * 用一个标志位记住「已经送过了」：用户之后自己把源删光、重启，不会又长回来。
 */
export async function ensureBundledSources(): Promise<boolean> {
  if (SOURCE_PRESETS.length === 0) return false
  if (await readStore<boolean>(BUNDLED_FLAG, false)) return migrateBundledSources()
  const existing = await listSources()
  if (existing.length) {
    await writeStore(BUNDLED_FLAG, true)
    return migrateBundledSources()
  }
  try {
    const source = await addPreset(SOURCE_PRESETS[0].id)
    await writeStore(BUNDLED_FLAG, true)
    await syncSource(source.id)
    return true
  } catch (err) {
    // 写不进去就退回首启引导页，用户仍然可以手动添加
    console.error('[presets] 首启写入内置订阅失败：', err)
    return false
  }
}

async function migrateBundledSources(): Promise<boolean> {
  const source = (await listSources()).find(
    (item) => item.kind === 'file' && basename(item.url) === `${CONGCONG_PRESET.id}.json`
  )
  if (!source || !existsSync(source.url)) return false

  try {
    const config = JSON.parse(readFileSync(source.url, 'utf8')) as Record<string, unknown>
    if (!Array.isArray(config.sites)) return false
    const currentSites = config.sites as Record<string, unknown>[]
    const normalizedSites = currentSites.filter((site) => String(site.key ?? '').trim().toLowerCase() !== 'jianpian').map((site) => {
      const key = String(site.key ?? '').trim().toLowerCase()
      const knownAndroidSource = isAndroidSource(key) || key === 'subo'
      const searchable = isSearchableByDefault(key)
      return {
        ...site,
        ...(String(site.name ?? '') === '素博资源' ? { name: '素博' } : {}),
        ...(knownAndroidSource ? { searchable: searchable ? 1 : 0 } : {}),
        ...(key === 'cz4k' || key === 'ryzy' ? { quickSearch: 0 } : {}),
        ...(key === 'ikanbot' ? { filterable: 1 } : {}),
        ...(knownAndroidSource && !searchable ? { enabled: true } : {})
      }
    })
    const mergedSites = mergeSites(normalizedSites, CONGCONG_PRESET.config.sites)
    const sitesChanged = JSON.stringify(mergedSites) !== JSON.stringify(currentSites)
    if (!sitesChanged) return false

    config.sites = mergedSites
    writeFileSync(source.url, JSON.stringify(config, null, 2), 'utf8')
    await syncSource(source.id)
    return true
  } catch (err) {
    console.error('[presets] 迁移 Android 1.0.74 影视源失败：', err)
    return false
  }
}
