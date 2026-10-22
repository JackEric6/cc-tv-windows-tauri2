import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { VodCard } from '@/components/VodCard'
import { Icon } from '@/components/icons'
import { mergeResults, useApp } from '@/store/useApp'
import { collectAdultTitleKeys, matchesAdultContent, normalizeName, posterMatchKeys } from '@/utils/normalize'
import { clearSearchHistory, getSearchHistory, rememberSearch, subscribeSearchHistory } from '@/utils/searchHistory'
import { androidSearchPriority, circledOrdinal, sourceDisplayLabel, sourceOrdinal } from '@shared/searchSourcePolicy'
import type { CategoryBucket } from '@shared/types'
import { translate } from '@/i18n'

export function Search(): JSX.Element {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const sites = useApp((s) => s.sites)
  const search = useApp((s) => s.search)
  const runSearch = useApp((s) => s.runSearch)
  const clearSearch = useApp((s) => s.clearSearch)
  const categories = useApp((s) => s.categories)
  const categoriesLoading = useApp((s) => s.categoriesLoading)
  const loadCategories = useApp((s) => s.loadCategories)
  const browse = useApp((s) => s.browse)
  const browseCategory = useApp((s) => s.browseCategory)
  const browseMore = useApp((s) => s.browseMore)
  const clearBrowse = useApp((s) => s.clearBrowse)
  const filterCommentary = useApp((s) => s.settings?.filterCommentary ?? false)
  const filterAdult = useApp((s) => s.sessionFilterAdult ?? s.settings?.filterAdult ?? true)
  const updateSettings = useApp((s) => s.updateSettings)

  const wdParam = params.get('wd') ?? ''
  const categorySources = useMemo(() => sites.filter((site) => site.enabled && !site.unsupported), [sites])
  const searchableSources = useMemo(() => categorySources.filter((site) => site.searchable), [categorySources])
  const usable = wdParam ? searchableSources : categorySources
  const [siteFilter, setSiteFilter] = useState<string | null>(null)
  const [searchHistory, setSearchHistory] = useState<string[]>(getSearchHistory)
  /** 已经发起过的关键词，避免 URL 变化重复触发 */
  const lastRun = useRef('')

  useEffect(() => subscribeSearchHistory(() => setSearchHistory(getSearchHistory())), [])

  // 顶部搜索框进来时自动开搜；没有关键词时进分类目录
  useEffect(() => {
    if (!wdParam || !usable.length) return
    if (lastRun.current === wdParam) return
    if (search.wd === wdParam && (search.running || search.results.length > 0)) {
      lastRun.current = wdParam
      setSiteFilter(null)
      return
    }
    lastRun.current = wdParam
    setSiteFilter(null)
    void runSearch(wdParam)
  }, [wdParam, usable.length, runSearch, search.wd, search.running, search.results.length])

  // 目录是懒加载的：第一次进没有关键词的页面时拉一次，之后复用
  useEffect(() => {
    if (wdParam) return
    if (categories.length || categoriesLoading) return
    void loadCategories()
  }, [wdParam, categories.length, categoriesLoading, loadCategories])

  useEffect(() => {
    if (wdParam || categoriesLoading || !categories.length || browse.bucket) return
    const first = categories.find((category) => category.name === '电影') ?? categories[0]
    void browseCategory(first.name, '')
  }, [wdParam, categoriesLoading, categories, browse.bucket, browseCategory])

  // 从「搜索结果」切回「分类目录」时把上一次的搜索结果收掉
  const hadWd = useRef('')
  useEffect(() => {
    const previous = hadWd.current
    hadWd.current = wdParam
    if (wdParam || !previous) return
    lastRun.current = ''
    clearSearch()
    setSiteFilter(null)
  }, [wdParam, clearSearch])

  const isBrowsing = !wdParam
  const searchMatchesRoute = search.wd === wdParam
  const searchPending = !isBrowsing && (!searchMatchesRoute || search.running)
  const source = isBrowsing ? browse.results : searchMatchesRoute ? search.results : []
  const orderedSource = useMemo(() => [...source].sort((a, b) =>
    androidSearchPriority(a.siteKey, a.siteName) - androidSearchPriority(b.siteKey, b.siteName)
  ), [source])
  const adultTitleKeys = useMemo(() => collectAdultTitleKeys(orderedSource), [orderedSource])
  const filteredSource = useMemo(() => orderedSource.map((result) => ({
    ...result,
    list: result.list.filter((vod) => !filterAdult || !matchesAdultContent(vod.vod_name, vod.type_name, adultTitleKeys, wdParam))
  })), [orderedSource, filterAdult, adultTitleKeys, wdParam])
  const sourceWithPosterFallback = useMemo(() => {
    const posters = new Map<string, string[]>()
    for (const result of filteredSource) {
      for (const vod of result.list) {
        if (!vod.vod_pic) continue
        for (const key of posterMatchKeys(vod.vod_name)) {
          const list = posters.get(key) ?? []
          if (!list.includes(vod.vod_pic)) list.push(vod.vod_pic)
          posters.set(key, list)
        }
      }
    }
    return filteredSource.map((result) => ({
      ...result,
      list: result.list.map((vod) => {
        const candidates = [...new Set(posterMatchKeys(vod.vod_name).flatMap((key) => posters.get(key) ?? []))]
          .filter((url) => url !== vod.vod_pic)
        return {
          ...vod,
          vod_pic: vod.vod_pic || candidates[0] || '',
          posterFallbacks: candidates
        }
      })
    }))
  }, [filteredSource])

  // 分类浏览翻页时把「已经上屏的顺序」交给合并函数，否则新一页里和前面同名的条目
  // 会让那一组多出一个源、按源数排序时整块跳到最前面，看起来就是「一翻页全部刷新」。
  //
  // 名次表由下面的 effect 维护；键对不上（刚换完分类）就不给提示。
  const orderRef = useRef<{ key: string; map: Map<string, number>; seq: number }>({
    key: '',
    map: new Map(),
    seq: 0
  })
  const orderKey = `${browse.bucket}::${browse.sub}`
  const previousOrder =
    isBrowsing && browse.page > 1 && orderRef.current.key === orderKey
      ? orderRef.current.map
      : undefined

  const { merged, hidden } = useMemo(
    () =>
      mergeResults(sourceWithPosterFallback, {
        keyword: isBrowsing ? '' : search.wd,
        filterCommentary,
        filterAdult,
        previousOrder
      }),
    [sourceWithPosterFallback, isBrowsing, search.wd, filterCommentary, filterAdult, previousOrder]
  )

  // 维护名次表。第一页（或换分类）时整个重建 —— 那一轮的排序就是标准排序，拿它当基准；
  // 之后只往里追加新名字，所以名次只增不改。
  //
  // 这里必须「重建」而不是「只追加」：同一个分类再点一次时 orderKey 根本没变，
  // 只看 key 会沿用上一轮留下的名次，翻页时照样按旧名次重排。
  useEffect(() => {
    const order = orderRef.current
    if (order.key !== orderKey || browse.page <= 1) {
      order.key = orderKey
      order.map = new Map()
      order.seq = 0
    }
    for (const v of merged) {
      const k = normalizeName(v.vod_name)
      if (!order.map.has(k)) order.map.set(k, order.seq++)
    }
  }, [merged, orderKey, browse.page])

  const displayResults = isBrowsing
    ? merged
    : filterAdult && searchPending
      ? []
      : sourceWithPosterFallback.flatMap((result) => result.list)
  const visible = siteFilter ? displayResults.filter((v) => v.siteKey === siteFilter) : displayResults

  const okSites = sourceWithPosterFallback.filter((r) => r.ok)
  const failedSites = source.filter((r) => !r.ok)
  const hitCount = okSites.reduce((sum, r) => sum + r.list.length, 0)

  function clearResults(): void {
    lastRun.current = ''
    clearSearch()
    clearBrowse()
    setParams({}, { replace: true })
  }

  function searchFromHistory(keyword: string): void {
    rememberSearch(keyword)
    navigate(`/?wd=${encodeURIComponent(keyword)}`)
  }

  const busy = isBrowsing ? browse.running : searchPending
  const progressTotal = searchMatchesRoute ? search.total || usable.length : usable.length

  // ---------- 向下滚动自动加载 ----------
  // 分类浏览一页只有 30 条，翻页全靠滚到底。用 IntersectionObserver 把「哨兵是否
  // 进入视口下方 500px」记成一个布尔值，再在 effect 里判断要不要真的发请求——
  // 不直接在回调里发请求，是因为「加载完新一页后哨兵可能还在视口里」这种情况
  // 不会产生新的交叉事件，光靠回调会卡住不再继续加载。
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(false)
  // 必须和下面哨兵 div 的渲染条件完全一致：哨兵只在「已经选了大类且这一大类
  // 首页加载完了」时才进 DOM。要是这里漏掉 !browse.running，effect 会在首屏还在
  // 请求、div 尚未挂载时就跑一次，拿到空 ref 直接返回；等 running 变 false、div
  // 真的出现时依赖没变、effect 不再重跑，观察器就永远没被挂上——表现为滚动到底
  // 什么都不发生。
  const sentinelVisible = isBrowsing && Boolean(browse.bucket) && !browse.running
  const canLoadMore =
    sentinelVisible && !browse.error && browse.page < browse.pageCount && !busy

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => setAtBottom(entries.some((e) => e.isIntersecting)),
      { rootMargin: '500px 0px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [sentinelVisible, browse.bucket, browse.sub])

  useEffect(() => {
    if (!atBottom || !canLoadMore || browse.loadingMore) return
    void browseMore()
  }, [atBottom, canLoadMore, browse.loadingMore, browse.page, browseMore])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">{translate(isBrowsing ? '分类浏览' : '聚合搜索')}</div>
          <div className="page-sub">
            {isBrowsing ? <BrowseSub /> : (
              `「${search.wd}」· ${okSites.length}/${progressTotal} ${translate('个站点有响应')} · ${translate('命中')} ${hitCount}${translate('条')}${
                hidden ? ` · ${translate('已挡掉')} ${hidden} ${translate('条解说')}` : ''
              }`
            )}
          </div>
        </div>
        <div className="page-actions">
          {searchPending ? (
            <span className="text-3 fs-13 hstack" style={{ gap: 8 }}>
              <span className="spin" />{translate("\n              正在搜索 ")}{searchMatchesRoute ? search.done : 0}/{progressTotal}
            </span>
          ) : null}
          {!isBrowsing || browse.bucket ? (
            <button type="button" className="btn btn-sm" onClick={clearResults}>{translate("\n              清空结果\n            ")}</button>
          ) : null}
          <button
            type="button"
            className={`chip ${filterCommentary ? 'active' : ''}`}
            title={translate("隐藏「XX解说 / 一口气看完」这类和正片同名的二创短片")}
            onClick={() => void updateSettings({ filterCommentary: !filterCommentary })}
          >
            <Icon name="filter" size={13} />{translate(" 过滤解说\n            ")}{hidden ? <span className="chip-count">{hidden}</span> : null}
          </button>
        </div>
      </div>

      {isBrowsing && searchHistory.length ? (
        <section className="search-history" aria-label={translate("最近搜索")}>
          <div className="search-history-head">
            <div className="search-history-title">
              <Icon name="clock" size={14} />
              <span>{translate("最近搜索")}</span>
            </div>
            <button
              type="button"
              className="search-history-clear"
              title={translate("清空搜索记录")}
              aria-label={translate("清空搜索记录")}
              onClick={clearSearchHistory}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
          <div className="search-history-list">
            {searchHistory.map((item) => (
              <button
                type="button"
                className="search-history-item"
                key={item}
                onClick={() => searchFromHistory(item)}
                title={`${translate('搜索 ')}${item}`}
              >
                <span>{item}</span>
                <Icon name="search" size={12} />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {!usable.length ? (
        <EmptyState
          icon={<Icon name="screen-off" size={26} />}
          title={translate("没有可用的影视源")}
          desc={translate('先到「影视源」页启用几个苹果CMS或网页规则类型的站点。需要 Spider 的站点在桌面端无法运行，会自动跳过。')}
          actions={
            <Link className="btn btn-primary" to="/sites">{translate("\n              前往影视源\n            ")}</Link>
          }
        />
      ) : null}

      {usable.length && isBrowsing ? (
        <CategoryBar
          categories={categories}
          loading={categoriesLoading}
          active={browse.bucket}
          onPick={(name) => {
            const bucket = categories.find((category) => category.name === name)
            void browseCategory(name, name === '电影' || bucket?.subs.length === 1 ? '' : bucket?.subs[0]?.name ?? '')
          }}
        />
      ) : null}

      {usable.length && isBrowsing && browse.bucket ? <SubBar /> : null}

      {usable.length && !isBrowsing ? (
        <div className="chips" style={{ marginBottom: 14 }}>
          <button
            type="button"
            className={`chip ${siteFilter === null ? 'active' : ''}`}
            onClick={() => setSiteFilter(null)}
          >{translate("\n            全部站点\n            ")}<span className="chip-count">{merged.length}</span>
          </button>
          {sourceWithPosterFallback.map((r) => (
            <button
              key={r.siteKey}
              type="button"
              className={`chip ${siteFilter === r.siteKey ? 'active' : ''}`}
              onClick={() => setSiteFilter(siteFilter === r.siteKey ? null : r.siteKey)}
              title={r.ok ? `${translate('用时 ')}${r.ms}ms` : translate('该站点未返回结果')}
            >
              <span className={`dot ${r.ok && r.list.length ? 'ok' : r.ok ? '' : 'bad'}`} />
              <span className="source-ordinal">
                <span className="source-ordinal-prefix">{translate('站点')}</span>
                <span className="source-ordinal-number">{sourceDisplayLabel(r.siteKey, r.siteName, sourceWithPosterFallback.findIndex((item) => item.siteKey === r.siteKey) + 1)}</span>
              </span>
              <span className="chip-count">{r.list.length}</span>
            </button>
          ))}
        </div>
      ) : null}

      {usable.length && (busy || source.length) ? (
        visible.length ? (
          <div className="poster-grid">
            {visible.map((vod, index) => (
              <VodCard key={`${vod.siteKey}-${vod.vod_id}-${index}`} vod={vod} />
            ))}
          </div>
        ) : (
          <EmptyState
            title={translate(busy ? '正在加载…' : '这里还没有内容')}
            desc={
              busy
                ? isBrowsing
                  ? translate('还有站点在返回数据，结果会陆续出现。')
                  : filterAdult
                    ? translate('正在汇总各站的分类标签，完成后统一显示结果。')
                    : translate('还有站点在返回数据，结果会陆续出现。')
                : isBrowsing
                  ? translate('换个分类试试，或者到「影视源」页测试站点是否可用。')
                  : translate('换个关键词试试，或者检查站点是否可用。')
            }
          />
        )
      ) : null}

      {isBrowsing && browse.bucket && !browse.running ? (
        <div className="load-more" ref={sentinelRef}>
          {browse.error ? (
            <>
              <span className="text-3 fs-13">{translate("下一页加载失败：")}{browse.error}</span>
              <button type="button" className="btn" onClick={() => void browseMore()}>
                <Icon name="refresh" size={13} />{translate("\n                重试\n              ")}</button>
            </>
          ) : browse.loadingMore ? (
            <span className="text-3 fs-13 hstack" style={{ gap: 8 }}>
              <span className="spin" />{translate("\n              正在加载第 ")}{browse.page + 1} / {browse.pageCount}{translate(" 页…\n            ")}</span>
          ) : browse.page < browse.pageCount ? (
            <span className="text-3 fs-13">{translate("向下滚动自动加载 · 第 ")}{browse.page} / {browse.pageCount}{translate(" 页")}</span>
          ) : (
            <span className="text-3 fs-13">{translate("已经到底了 · 共 ")}{browse.page}{translate(" 页")}</span>
          )}
        </div>
      ) : null}

      {!busy && source.length && failedSites.length ? (
        <details className="failed-sites">
          <summary>
            {failedSites.length}{translate(" 个站点没有返回结果\n            ")}<span className="text-3 fs-12">{translate("（点开看原因）")}</span>
          </summary>
          <div className="list">
            {failedSites.map((r) => (
              <div className="list-row" key={r.siteKey}>
                <div className="list-row-main">
                  <div className="list-row-title">
                    <span className="source-ordinal">
                      <span className="source-ordinal-prefix">{translate('站点')}</span>
                      <span className="source-ordinal-number">{sourceDisplayLabel(r.siteKey, r.siteName, failedSites.findIndex((item) => item.siteKey === r.siteKey) + 1)}</span>
                    </span>
                  </div>
                  <div className="list-row-sub">{translate('该站点未返回结果')}</div>
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}

/** 大类下有多少个站点能查（一个站点可能在多个子分类里出现，要去重） */
function bucketSites(bucket: CategoryBucket | undefined): number {
  if (!bucket) return 0
  return new Set(bucket.subs.flatMap((s) => s.sites.map((x) => x.siteKey))).size
}

/** 目录页的副标题：说明有多少个站点能读出来分类 */
function BrowseSub(): JSX.Element {
  const categories = useApp((s) => s.categories)
  const browse = useApp((s) => s.browse)
  if (browse.bucket) {
    const bucket = categories.find((c) => c.name === browse.bucket)
    const picked = browse.sub
      ? (bucket?.subs.filter((s) => s.name === browse.sub) ?? [])
      : (bucket?.subs ?? [])
    const siteCount = new Set(picked.flatMap((s) => s.sites.map((x) => x.siteKey))).size
    return (
      <>
        「{browse.bucket}
        {browse.sub ? ` · ${browse.sub}` : ''}{translate("」· 来自 ")}{siteCount}{translate(" 个站点 · 累计")}{' '}
        {browse.results.reduce((n, r) => n + r.list.length, 0)}{translate(" 条\n      ")}</>
    )
  }
  return <>{translate("按类型浏览各个影视源的内容，选一个分类开始")}</>
}

/** 选中大类之后，在它下面再列一排子分类 */
function SubBar(): JSX.Element | null {
  const categories = useApp((s) => s.categories)
  const browse = useApp((s) => s.browse)
  const browseCategory = useApp((s) => s.browseCategory)

  const bucket = categories.find((c) => c.name === browse.bucket)
  if (!bucket || bucket.subs.length < 2) return null

  return (
    <div className="chips sub-bar">
      <button
        type="button"
        className={`chip ${browse.sub ? '' : 'active'}`}
        onClick={() => void browseCategory(bucket.name, '')}
      >{translate("\n        全部\n      ")}</button>
      {bucket.subs.map((s) => (
        <button
          key={s.name}
          type="button"
          className={`chip ${browse.sub === s.name ? 'active' : ''}`}
          title={`${s.sites.length} 个站点里有这个子分类`}
          onClick={() => void browseCategory(bucket.name, browse.sub === s.name ? '' : s.name)}
        >
          {s.name}
          <span className="chip-count">{s.sites.length}</span>
        </button>
      ))}
    </div>
  )
}

function CategoryBar({
  categories,
  loading,
  active,
  onPick
}: {
  categories: CategoryBucket[]
  loading: boolean
  active: string
  onPick: (name: string) => void
}): JSX.Element {
  if (loading && !categories.length) {
    return (
      <div className="cat-bar">
        <span className="text-3 fs-13 hstack" style={{ gap: 8 }}>
          <span className="spin" />{translate(" 正在读取各站点的分类…\n        ")}</span>
      </div>
    )
  }
  if (!categories.length) {
    return (
      <div className="cat-bar">
        <span className="text-3 fs-13">{translate("\n          没有读到分类目录。只有苹果CMS类型的站点支持分类浏览，可以先到「影视源」页测试一下站点。\n        ")}</span>
      </div>
    )
  }
  return (
    <div className="cat-grid">
      {categories.map((c) => (
        <button
          key={c.name}
          type="button"
          className={`cat-card ${active === c.name ? 'active' : ''}`}
          onClick={() => onPick(c.name)}
        >
          <span className="cat-name">{c.name}</span>
          <span className="cat-meta">
            {bucketSites(c)}{translate(" 个源 · ")}{c.subs.length}{translate(" 个子分类\n          ")}</span>
        </button>
      ))}
    </div>
  )
}
