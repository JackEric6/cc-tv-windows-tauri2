const ANDROID_SOURCE_ORDER = [
  'xgzy', '360zy', 'iqiyi', 'uuzy', 'wujin', 'wsyzy', 'haohua', 'ryzy', 'niuniu', 'kuaiche',
  'bfzy', 'lzi', 'suboziyuan', 'tyzy', 'yaya', 'jinying', 'guangsu', 'dyttzy', 'jisu', 'huya',
  'xinlang', 'shandian', 'maoyan', 'okzy', 'ffzy', 'douban', 'dzzy', 'juliang', 'bdzy', 'yhzy',
  'ukuzy', 'zuida', 'hongniu', 'modu', 'yparse', 'mtzy0',
  'ikanbot', 'fhw88', 'guazi', 'cz4k', 'cechi', 'zanpian', 'fan_nomi', 'fan_moli',
  'fan_cheese', 'fan_jianpian', 'cms_baidu', 'cms_baofeng', 'jianpian'
]

const ANDROID_SOURCE_KEYS = new Set([...ANDROID_SOURCE_ORDER, 'yutu'])
const SEARCH_PRIORITY = new Map(ANDROID_SOURCE_ORDER.map((key, index) => [key, index]))
const FIXED_DISPLAY_ORDER = [
  'guazi', 'xgzy', 'dyttzy', 'ffzy', 'bfzy', 'lzi', 'fhw88', 'fan_nomi', 'fan_cheese',
  '360zy', 'haohua', 'suboziyuan', 'jinying', 'guangsu', 'jisu', 'huya', 'xinlang',
  'maoyan', 'bdzy', 'modu', 'ikanbot', 'juliang', 'dzzy', 'ukuzy'
]
const DISPLAY_PRIORITY = new Map(FIXED_DISPLAY_ORDER.map((key, index) => [key, index]))
const CIRCLED_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳', '㉑', '㉒', '㉓', '㉔']
// 默认搜索策略只控制参与搜索的站点，不控制影视源本身的启停。
const DEFAULT_SEARCHABLE_SOURCES = new Set([
  'haohua', 'dzzy', 'ffzy', 'bfzy', 'guangsu', 'huya', 'jisu', 'guazi', 'fan_nomi', 'jinying',
  'cheese', 'bdzy', '360zy', 'lzi', 'maoyan', 'modu', 'juliang', 'dyttzy',
  'jianpian', 'xgzy', 'suboziyuan', 'fhw88', 'ukuzy', 'xinlang', 'ikanbot'
])
const SOURCE_ALIASES: Record<string, string> = {
  moli: 'fan_moli',
  cheese: 'fan_cheese',
  cms_baidu: 'bdzy',
  '360': '360zy',
  '糯米': 'fan_nomi',
  '茉莉': 'fan_moli',
  '奶酪': 'fan_cheese',
  '荐片': 'jianpian',
  '视界': 'xgzy'
}
const NAME_ALIASES: Array<[string, string]> = [
  ['瓜子', 'guazi'], ['荐片', 'jianpian'], ['西瓜', 'xgzy'], ['非凡', 'ffzy'], ['360', '360zy'],
  ['暴风', 'bfzy'], ['天堂', 'dyttzy'], ['量子', 'lzi'], ['如意', 'ryzy'],
  ['鑫同', 'fhw88'], ['厂长', 'cz4k'], ['茉莉', 'fan_moli'], ['奶酪', 'fan_cheese'],
  ['糯米', 'fan_nomi'], ['爱看', 'ikanbot'], ['奇艺', 'iqiyi'], ['百度', 'bdzy'],
  ['豪华', 'haohua'], ['速播', 'suboziyuan'], ['金鹰', 'jinying'], ['光速', 'guangsu'],
  ['极速', 'jisu'], ['虎牙', 'huya'], ['新浪', 'xinlang'], ['猫眼', 'maoyan'],
  ['魔都', 'modu'], ['巨量', 'juliang'], ['大众', 'dzzy'], ['U酷', 'ukuzy']
]

export function isAndroidSource(siteKey: string): boolean {
  const key = siteKey.trim().toLowerCase()
  return ANDROID_SOURCE_KEYS.has(SOURCE_ALIASES[key] ?? key)
}

export function isSearchableByDefault(siteKey: string): boolean {
  return DEFAULT_SEARCHABLE_SOURCES.has(siteKey.trim().toLowerCase())
}

export function isAndroidSearchSource(siteKey: string): boolean {
  const key = siteKey.trim().toLowerCase()
  return SEARCH_PRIORITY.has(SOURCE_ALIASES[key] ?? key)
}

export function androidSearchPriority(siteKey: string, siteName = ''): number {
  const key = siteKey.trim().toLowerCase()
  const normalizedKey = SOURCE_ALIASES[key] ?? key
  const name = siteName.replace(/资源|采集/g, '').trim()
  const match = NAME_ALIASES.find(([label]) => name.includes(label))
  return DISPLAY_PRIORITY.get(normalizedKey) ?? (match ? DISPLAY_PRIORITY.get(match[1]) : undefined) ?? 1000
}

export function sourceOrdinal(siteKey: string, siteName = ''): number | undefined {
  const priority = androidSearchPriority(siteKey, siteName)
  return priority < FIXED_DISPLAY_ORDER.length ? priority + 1 : undefined
}

export function circledOrdinal(ordinal: number): string {
  return CIRCLED_NUMBERS[ordinal - 1] ?? String(ordinal)
}

export function sourceDisplayLabel(siteKey: string, siteName = '', fallbackOrdinal = 1): string {
  return circledOrdinal(sourceOrdinal(siteKey, siteName) ?? Math.max(1, fallbackOrdinal))
}
