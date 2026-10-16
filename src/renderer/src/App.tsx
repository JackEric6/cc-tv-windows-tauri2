import { useEffect, useState } from 'react'
import { matchPath, NavLink, Route, Routes, useLocation, useNavigationType, useSearchParams } from 'react-router-dom'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { Toasts } from '@/components/Toasts'
import { Icon } from '@/components/icons'
import { useApp } from '@/store/useApp'
import { setUiLanguage, translate } from '@/i18n'
import { Home } from '@/pages/Home'
import { Search } from '@/pages/Search'
import { Player } from '@/pages/Player'
import { Detail } from '@/pages/Detail'
import { PlaybackHome } from '@/pages/PlaybackHome'
import { Library } from '@/pages/Library'
import { Sites } from '@/pages/Sites'
import { Settings } from '@/pages/Settings'
import { Downloads } from '@/pages/Downloads'
import { OfflinePlayer } from '@/pages/OfflinePlayer'
import '@/styles/pages.css'

export default function App(): JSX.Element {
  const location = useLocation()
  const navigationType = useNavigationType()
  const [lastPlayerLocation, setLastPlayerLocation] = useState<ReturnType<typeof useLocation> | null>(null)
  const isPlayerRoute = Boolean(matchPath('/play/:siteKey/:vodId/:lineIndex/:epIndex', location.pathname))
  const clearCachedPlayer = (location.state as { clearPlayer?: unknown } | null)?.clearPlayer === true
  const restorePlayerFromTab = location.pathname === '/play' && Boolean(lastPlayerLocation) && !clearCachedPlayer
  const playerVisible = isPlayerRoute || restorePlayerFromTab
  const playerLocation = isPlayerRoute ? location : lastPlayerLocation
  const ready = useApp((s) => s.ready)
  const init = useApp((s) => s.init)
  const sources = useApp((s) => s.sources)
  const language = useApp((s) => s.settings?.language ?? 'zh-CN')
  setUiLanguage(language)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (isPlayerRoute) setLastPlayerLocation(location)
  }, [isPlayerRoute, location])

  useEffect(() => {
    if (clearCachedPlayer) setLastPlayerLocation(null)
  }, [clearCachedPlayer, location.key])

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-logo">CC</div>
        <div className="boot-text">{translate("正在加载本地配置…")}</div>
      </div>
    )
  }

  const noSources = sources.length === 0

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <TopBar />
        <main className="app-content">
          {playerVisible ? null : (
              <Routes>
                <Route path="/" element={noSources ? <FirstRun /> : <HomeRoute />} />
                <Route path="/play" element={<PlaybackHome />} />
                <Route path="/search" element={<Search />} />
                <Route path="/detail/:siteKey/:vodId" element={<Detail />} />
                <Route path="/library" element={<Library />} />
                <Route path="/downloads" element={<Downloads />} />
                <Route path="/offline/:id" element={<OfflinePlayer />} />
                <Route path="/sites" element={<Sites />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={noSources ? <FirstRun /> : <Home />} />
              </Routes>
            )}
          {playerLocation ? (
            <div className={`player-persistent-host${playerVisible ? ' visible' : ''}`} aria-hidden={!playerVisible}>
              <Routes location={playerLocation}>
                <Route path="/play/:siteKey/:vodId/:lineIndex/:epIndex" element={
                  <Player visible={playerVisible} autoPlay={isPlayerRoute && navigationType !== 'POP'} />
                } />
              </Routes>
            </div>
          ) : null}
        </main>
      </div>
      <Toasts />
    </div>
  )
}

function HomeRoute(): JSX.Element {
  const [params] = useSearchParams()
  return params.get('wd')?.trim() ? <Search /> : <Home />
}

/** 首次启动：还没有任何配置源，直接引导到配置页而不是给一个空壳 */
function FirstRun(): JSX.Element {
  const presets = useApp((s) => s.presets)
  const addPreset = useApp((s) => s.addPreset)
  const [busy, setBusy] = useState('')

  return (
    <div className="page">
      <div className="first-run">
        <div className="first-run-logo">CC</div>
        <h1 className="first-run-title">{translate("欢迎使用丛丛影视")}</h1>
        <p className="first-run-desc">{translate("\n          丛丛影视 Windows 桌面版已内置影视源，支持多线路搜索、选集播放、M3U8 净化与弹幕。\n        ")}</p>
        <div className="first-run-actions">
          <NavLink to="/search" className="btn btn-primary">{translate("\n            开始搜索\n          ")}</NavLink>
          <NavLink to="/sites" className="btn">{translate("\n            查看影视源\n          ")}</NavLink>
        </div>

        {presets.length ? (
          <div className="first-run-presets">
            <div className="first-run-presets-title">{translate("或者一键添加内置推荐订阅")}</div>
            {presets.map((preset) => (
              <div className="preset-row" key={preset.id}>
                <div className="grow">
                  <div className="list-row-title">{preset.name}</div>
                  <div className="list-row-sub">{preset.desc}</div>
                </div>
                <span className="tag tag-outline">
                  {preset.siteCount}{translate(" 个站点\n                ")}</span>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy === preset.id}
                  onClick={async () => {
                    setBusy(preset.id)
                    await addPreset(preset.id)
                    setBusy('')
                  }}
                >
                  {busy === preset.id ? <span className="spin" /> : <Icon name="plus" size={13} />}{translate("\n                  添加\n                ")}</button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="first-run-steps">
          <div className="first-run-step">
            <span className="first-run-num">1</span>
            <div>
              <b>{translate("添加配置源")}</b>
              <div className="text-3 fs-12">{translate("填入订阅 URL，或选择一个本地 .json 配置文件")}</div>
            </div>
          </div>
          <div className="first-run-step">
            <span className="first-run-num">2</span>
            <div>
              <b>{translate("启用影视源")}</b>
              <div className="text-3 fs-12">{translate("在「影视源」页测试连通性，关掉速度慢或失效的站点")}</div>
            </div>
          </div>
          <div className="first-run-step">
            <span className="first-run-num">3</span>
            <div>
              <b>{translate("搜索并播放")}</b>
              <div className="text-3 fs-12">{translate("顶部搜索框回车即可同时查询全部站点")}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
