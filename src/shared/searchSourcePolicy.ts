const ANDROID_SOURCE_ORDER = [
  'xgzy', '360zy', 'iqiyi', 'uuzy', 'wujin', 'wsyzy', 'haohua', 'ryzy', 'niuniu', 'kuaiche',
  'bfzy', 'lzi', 'suboziyuan', 'tyzy', 'yaya', 'jinying', 'guangsu', 'dyttzy', 'jisu', 'huya',
  'xinlang', 'shandian', 'maoyan', 'okzy', 'ffzy', 'douban', 'dzzy', 'juliang', 'bdzy', 'yhzy',
  'ukuzy', 'zuida', 'hongniu', 'modu', 'yparse', 'mtzy0',
  'ikanbot', 'fhw88', 'guazi', 'cz4k', 'jianpian', 'cechi', 'zanpian', 'fan_nomi', 'fan_moli',
  'fan_cheese', 'fan_jianpian', 'cms_baidu', 'cms_baofeng'
]

const ANDROID_SOURCE_KEYS = new Set([...ANDROID_SOURCE_ORDER, 'yutu'])
const SEARCH_PRIORITY = new Map(ANDROID_SOURCE_ORDER.map((key, index) => [key, index]))
const SEARCH_RESULT_ORDER = new Map([
  ['guazi', 0],
  ['jianpian', 1],
  ['xgzy', 2],
  ['ffzy', 3],
  ['bfzy', 4],
  ['dyttzy', 5],
  ['lzi', 6],
  ['ryzy', 7],
  ['360zy', 8]
])
// 2026-10-14 实测只有这 30 个源能对「庆余年」返回结果；此策略只控制搜索，不控制整源启停。
const DEFAULT_SEARCHABLE_SOURCES = new Set([
  'haohua', 'dzzy', 'ffzy', 'bfzy', 'guangsu', 'huya', 'jisu', 'guazi', 'fan_nomi', 'jinying',
  'cheese', 'moli', 'bdzy', '360zy', 'lzi', 'maoyan', 'modu', 'juliang', 'ryzy', 'dyttzy',
  'jianpian', 'xgzy', 'suboziyuan', 'fhw88', 'ukuzy', 'iqiyi', 'xinlang', 'zuida', 'cz4k', 'ikanbot'
])
const SOURCE_ALIASES: Record<string, string> = {
  moli: 'fan_moli',
  cheese: 'fan_cheese',
  '糯米': 'fan_nomi',
  '茉莉': 'fan_moli',
  '奶酪': 'fan_cheese',
  '荐片': 'jianpian',
  '视界': 'xgzy'
}
const NAME_ALIASES: Array<[string, string]> = [
  ['瓜子', 'guazi'], ['荐片', 'jianpian'], ['西瓜', 'xgzy'], ['非凡', 'ffzy'],
  ['暴风', 'bfzy'], ['天堂', 'dyttzy'], ['量子', 'lzi'], ['如意', 'ryzy'],
  ['鑫同', 'fhw88'], ['厂长', 'cz4k'], ['茉莉', 'fan_moli'], ['奶酪', 'fan_cheese'],
  ['糯米', 'fan_nomi'], ['爱看', 'ikanbot'], ['奇艺', 'iqiyi'], ['百度', 'cms_baidu']
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
  const fixed = SEARCH_RESULT_ORDER.get(normalizedKey)
  if (fixed !== undefined) return fixed

  const direct = SEARCH_PRIORITY.get(normalizedKey)
  if (direct !== undefined) return direct + SEARCH_RESULT_ORDER.size

  const name = siteName.replace(/资源|采集/g, '').trim()
  const match = NAME_ALIASES.find(([label]) => name.includes(label))
  if (!match) return 100
  return SEARCH_RESULT_ORDER.get(match[1]) ?? (SEARCH_PRIORITY.get(match[1]) ?? 100) + SEARCH_RESULT_ORDER.size
}
