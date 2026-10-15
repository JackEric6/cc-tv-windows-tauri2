const STORAGE_KEY = 'cc-tv-search-history'
const CHANGE_EVENT = 'cc-tv-search-history-change'
const MAX_ITEMS = 12

export function getSearchHistory(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))].slice(
          0,
          MAX_ITEMS
        )
      : []
  } catch {
    return []
  }
}

export function rememberSearch(keyword: string): void {
  const value = keyword.trim()
  if (!value) return
  const next = [value, ...getSearchHistory().filter((item) => item !== value)].slice(0, MAX_ITEMS)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function clearSearchHistory(): void {
  localStorage.removeItem(STORAGE_KEY)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function removeSearchHistory(keyword: string): void {
  const value = keyword.trim()
  if (!value) return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(getSearchHistory().filter((item) => item !== value)))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeSearchHistory(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => window.removeEventListener(CHANGE_EVENT, onChange)
}
