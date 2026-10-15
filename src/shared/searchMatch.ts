export function normalizeSearchTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]+/gu, '')
}

function comparableTitle(value: string): string {
  return normalizeSearchTitle(value)
    .replace(/(?:19|20)\d{2}/g, '')
    .replace(/(?:第)?\d+[-~至]\d+(?:集|话|回|期|話)?/g, '')
    .replace(/(?:第)?\d+(?:集|话|回|期|話)/g, '')
    .replace(/电视剧|国产剧|电影|动漫|综艺|全集|完整版|已完结|完结|更新至|高清|超清|蓝光|1080p|720p|4k/gi, '')
}

export function matchesFullSearchKeyword(title: string, keyword: string): boolean {
  const normalizedKeyword = comparableTitle(keyword)
  const normalizedTitle = comparableTitle(title)
  return Boolean(normalizedKeyword && normalizedTitle.startsWith(normalizedKeyword))
}
