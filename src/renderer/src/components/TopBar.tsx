import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '@/store/useApp'
import { Icon } from './icons'
import {
  clearSearchHistory,
  getSearchHistory,
  rememberSearch,
  removeSearchHistory,
  subscribeSearchHistory
} from '@/utils/searchHistory'
import { translate } from '@/i18n'

export function TopBar(): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const info = useApp((s) => s.info)
  const syncAll = useApp((s) => s.syncAll)
  const syncing = useApp((s) => s.syncing)
  const home = useApp((s) => s.home)
  const runSearch = useApp((s) => s.runSearch)

  const [keyword, setKeyword] = useState('')
  const [focused, setFocused] = useState(false)
  const [history, setHistory] = useState<string[]>(getSearchHistory)
  const [remoteSuggestions, setRemoteSuggestions] = useState<string[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const suggestionRequest = useRef(0)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busy = Object.keys(syncing).length > 0
  const query = keyword.trim()
  const normalizedQuery = query.toLocaleLowerCase()
  const localSuggestions = useMemo(() => {
    const titles = home.flatMap((section) => section.items.map((item) => item.vod_name))
    const unique = [...new Set(titles.map((item) => item.trim()).filter(Boolean))]
    return unique.filter((item) => item.toLocaleLowerCase().includes(normalizedQuery)).slice(0, 8)
  }, [home, normalizedQuery])
  const historySuggestions = history.filter((item) => item.toLocaleLowerCase().includes(normalizedQuery))
  const suggestions = remoteSuggestions.length
    ? remoteSuggestions
    : [...new Set([...localSuggestions, ...historySuggestions])].slice(0, 8)

  useEffect(() => subscribeSearchHistory(() => setHistory(getSearchHistory())), [])

  useEffect(() => {
    const requestId = ++suggestionRequest.current
    if (!focused || query.length < 2) {
      setRemoteSuggestions([])
      setSuggestionsLoading(false)
      return
    }
    setRemoteSuggestions([])
    setSuggestionsLoading(true)
    const timer = window.setTimeout(() => {
      void window.api.search.suggest(query).then((items) => {
        if (requestId === suggestionRequest.current) setRemoteSuggestions(items)
      }).catch(() => {
        if (requestId === suggestionRequest.current) setRemoteSuggestions([])
      }).finally(() => {
        if (requestId === suggestionRequest.current) setSuggestionsLoading(false)
      })
    }, 260)
    return () => window.clearTimeout(timer)
  }, [focused, query])

  // 路由在首页承载搜索结果；返回或直达搜索链接时同步输入框。
  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '/search') {
      const wd = new URLSearchParams(location.search).get('wd') ?? ''
      setKeyword(wd)
    }
  }, [location])

  function submit(value = keyword): void {
    const wd = value.trim()
    if (!wd) return
    rememberSearch(wd)
    setKeyword(wd)
    setFocused(false)
    if (blurTimer.current) clearTimeout(blurTimer.current)
    const currentWd = new URLSearchParams(location.search).get('wd') ?? ''
    if (location.pathname === '/' && currentWd === wd) void runSearch(wd)
    else navigate(`/?wd=${encodeURIComponent(wd)}`)
  }

  const showSuggestions = focused
  const clearHistory = (): void => {
    clearSearchHistory()
    setHistory([])
  }

  return (
    <header className="topbar">
      <div className={`search-box${showSuggestions ? ' has-suggestions' : ''}`}>
        <span className="search-icon">
          <Icon name="search" size={15} />
        </span>
        <input
          value={keyword}
          placeholder={translate("搜索影片、剧集、动漫…（回车聚合全部站点）")}
          onChange={(e) => setKeyword(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setFocused(false), 140)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') setFocused(false)
          }}
        />
        {showSuggestions ? (
          <div className="search-suggestions" role="group" aria-label={translate(query ? '搜索建议' : '搜索记录')}>
            {!query ? (
              <div className="search-suggestion-group">
                <div className="search-suggestions-heading">
                  <span>{translate("搜索记录")}</span>
                  {history.length ? (
                    <button
                      type="button"
                      className="search-history-clear"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={clearHistory}
                      title={translate("清空搜索记录")}
                      aria-label={translate("清空搜索记录")}
                    ><Icon name="trash" size={14} /></button>
                  ) : null}
                </div>
                {history.length ? (
                  <div className="search-suggestion-list">
                    {history.map((item) => (
                      <div className="search-history-row" key={item}>
                        <button
                          type="button"
                          className="search-suggestion"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => submit(item)}
                        >
                          <Icon name="clock" size={13} />
                          <span>{item}</span>
                        </button>
                        <button
                          type="button"
                          className="search-history-remove"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => removeSearchHistory(item)}
                          title={`${translate('删除搜索记录：')}${item}`}
                          aria-label={`${translate('删除搜索记录：')}${item}`}
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="search-suggestions-empty">{translate("暂无搜索记录")}</div>
                )}
              </div>
            ) : (
              <div className="search-suggestion-group">
                <div className="search-suggestions-heading">{translate("搜索建议")}</div>
                {suggestions.length ? (
                  <div className="search-suggestion-list">
                    {suggestions.map((item) => (
                      <button
                        type="button"
                        className="search-suggestion"
                        key={item}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => submit(item)}
                      >
                        <Icon name="search" size={13} />
                        <span>{item}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="search-suggestions-empty">
                    {translate(suggestionsLoading ? '正在获取建议…' : '暂无匹配建议，按 Enter 搜索当前关键词')}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="topbar-spacer" />

      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => void syncAll()}
        title={translate("重新拉取所有已启用的配置源")}
      >
        {busy ? <span className="spin" /> : <Icon name="refresh" size={14} />}{translate(" 同步配置\n      ")}</button>

      <span className="tag tag-outline mono" title={`用户数据目录：${info?.userData ?? ''}`}>
        v{info?.version ?? '0.1.0'}
      </span>
    </header>
  )
}
