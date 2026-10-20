import { lazy, Suspense, useEffect, useState } from 'react'
import { matchPath, Navigate, NavLink, Route, Routes, useLocation, useNavigationType, useParams, useSearchParams } from 'react-router-dom'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { Toasts } from '@/components/Toasts'
import { Icon } from '@/components/icons'
import { useApp } from '@/store/useApp'
import { setUiLanguage, translate } from '@/i18n'
import '@/styles/pages.css'

const Home = lazy(() => import('@/pages/Home').then((module) => ({ default: module.Home })))
const Search = lazy(() => import('@/pages/Search').then((module) => ({ default: module.Search })))
const Player = lazy(() => import('@/pages/Player').then((module) => ({ default: module.Player })))
const PlaybackHome = lazy(() => import('@/pages/PlaybackHome').then((module) => ({ default: module.PlaybackHome })))
const Library = lazy(() => import('@/pages/Library').then((module) => ({ default: module.Library })))
const Sites = lazy(() => import('@/pages/Sites').then((module) => ({ default: module.Sites })))
const Settings = lazy(() => import('@/pages/Settings').then((module) => ({ default: module.Settings })))
const Downloads = lazy(() => import('@/pages/Downloads').then((module) => ({ default: module.Downloads })))
const OfflinePlayer = lazy(() => import('@/pages/OfflinePlayer').then((module) => ({ default: module.OfflinePlayer })))

const SKIPPED_UPDATE_VERSION_KEY = 'cc-tv-skipped-update-version'

export default function App(): JSX.Element {
  const location = useLocation()
  const navigationType = useNavigationType()
  const routeState = location.state as { autoPlay?: unknown } | null
  const [lastPlayerLocation, setLastPlayerLocation] = useState<ReturnType<typeof useLocation> | null>(null)
  const [updatePrompt, setUpdatePrompt] = useState<{ version: string; currentVersion: string; notes: string } | null>(null)
  const [updateInstalling, setUpdateInstalling] = useState(false)
  const [updateProgress, setUpdateProgress] = useState({ downloaded: 0, total: 0 })
  const isPlayerRoute = Boolean(matchPath('/play/:siteKey/:vodId/:lineIndex/:epIndex', location.pathname))
  const clearCachedPlayer = (location.state as { clearPlayer?: unknown } | null)?.clearPlayer === true
  const restorePlayerFromTab = location.pathname === '/play' && Boolean(lastPlayerLocation) && !clearCachedPlayer
  const playerVisible = isPlayerRoute || restorePlayerFromTab
  const playerLocation = isPlayerRoute ? location : lastPlayerLocation
  const ready = useApp((s) => s.ready)
  const init = useApp((s) => s.init)
  const sources = useApp((s) => s.sources)
  const notify = useApp((s) => s.notify)
  const language = useApp((s) => s.settings?.language ?? 'zh-CN')
  setUiLanguage(language)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const update = await window.api.updater.check()
          if (!update.hasUpdate) return
          if (localStorage.getItem(SKIPPED_UPDATE_VERSION_KEY) === update.latestVersion) return
          setUpdatePrompt({
            version: update.latestVersion,
            currentVersion: update.currentVersion,
            notes: update.notes.slice(0, 1600)
          })
        } catch (error) {
          console.warn('[updater] 自动检查更新失败', error)
        }
      })()
    }, 3000)
    return () => window.clearTimeout(timer)
  }, [notify])

  useEffect(() => window.api.updater.onDownloadProgress(setUpdateProgress), [])

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

  async function installUpdate(): Promise<void> {
    if (!updatePrompt || updateInstalling) return
    setUpdateInstalling(true)
    setUpdateProgress({ downloaded: 0, total: 0 })
    try {
      notify(`正在下载 v${updatePrompt.version} 更新包…`, 'info')
      const installer = await window.api.updater.download(updatePrompt.version)
      await window.api.updater.install(installer)
    } catch (error) {
      notify(`更新失败：${(error as Error).message}`, 'danger')
      setUpdateInstalling(false)
      setUpdatePrompt(null)
    }
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <TopBar />
        <main className="app-content">
          {playerVisible ? null : (
              <Suspense fallback={<div className="boot"><span className="spin" /></div>}>
                <Routes>
                  <Route path="/" element={noSources ? <FirstRun /> : <HomeRoute />} />
                  <Route path="/play" element={<PlaybackHome />} />
                  <Route path="/search" element={<Search />} />
                  <Route path="/detail/:siteKey/:vodId" element={<LegacyDetailRedirect />} />
                  <Route path="/library" element={<Library />} />
                  <Route path="/downloads" element={<Downloads />} />
                  <Route path="/offline/:id" element={<OfflinePlayer />} />
                  <Route path="/sites" element={<Sites />} />
                  <Route path="/settings" element={<Settings onUpdateFound={(update) => {
                    if (localStorage.getItem(SKIPPED_UPDATE_VERSION_KEY) === update.version) {
                      notify(`已跳过版本 v${update.version}`, 'info')
                      return
                    }
                    setUpdatePrompt(update)
                  }} />} />
                  <Route path="*" element={noSources ? <FirstRun /> : <Home />} />
                </Routes>
              </Suspense>
            )}
          {playerLocation ? (
            <div className={`player-persistent-host${playerVisible ? ' visible' : ''}`} aria-hidden={!playerVisible}>
              <Suspense fallback={<div className="boot"><span className="spin" /></div>}>
                <Routes location={playerLocation}>
                  <Route path="/play/:siteKey/:vodId/:lineIndex/:epIndex" element={
                    <Player visible={playerVisible} autoPlay={isPlayerRoute && (navigationType !== 'POP' || routeState?.autoPlay === true)} />
                  } />
                </Routes>
              </Suspense>
            </div>
          ) : null}
        </main>
      </div>
      <Toasts />
      {updatePrompt ? (
        <div className="update-prompt-backdrop">
          <section className="update-prompt" role="dialog" aria-modal="true" aria-labelledby="update-prompt-title">
            <div className="update-prompt-heading">
              <Icon name="refresh" size={19} />
              <h2 id="update-prompt-title">发现新版本 v{updatePrompt.version}</h2>
            </div>
            <p className="text-3">当前版本 v{updatePrompt.currentVersion}。是否现在下载并安装更新？</p>
            {updatePrompt.notes ? <pre className="update-prompt-notes">{updatePrompt.notes}</pre> : null}
            {updateInstalling ? (
              <div className="update-progress">
                <div className="update-progress-label">
                  <span>正在下载更新</span>
                  <span>{updateProgress.total > 0 ? `${Math.min(100, Math.floor(updateProgress.downloaded / updateProgress.total * 100))}%` : '准备中…'}</span>
                </div>
                <progress max={updateProgress.total || 1} value={updateProgress.downloaded} />
                {updateProgress.total > 0 ? <div className="field-hint">{(updateProgress.downloaded / 1048576).toFixed(1)} / {(updateProgress.total / 1048576).toFixed(1)} MB</div> : null}
              </div>
            ) : null}
            <div className="update-prompt-actions">
              <button type="button" className="btn" disabled={updateInstalling} onClick={() => setUpdatePrompt(null)}>稍后</button>
              <button type="button" className="btn" disabled={updateInstalling} onClick={() => {
                localStorage.setItem(SKIPPED_UPDATE_VERSION_KEY, updatePrompt.version)
                setUpdatePrompt(null)
                notify(`已跳过版本 v${updatePrompt.version}`, 'success')
              }}>跳过此版本</button>
              <button type="button" className="btn btn-primary" disabled={updateInstalling} onClick={() => void installUpdate()}>
                {updateInstalling ? <><span className="spin" />{updateProgress.total > 0 && updateProgress.downloaded >= updateProgress.total ? '正在校验…' : '正在下载…'}</> : '立即更新'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}

function HomeRoute(): JSX.Element {
  const [params] = useSearchParams()
  return params.get('wd')?.trim() ? <Search /> : <Home />
}

function LegacyDetailRedirect(): JSX.Element {
  const { siteKey = '', vodId = '' } = useParams()
  const location = useLocation()
  const routeState = location.state as { returnTo?: unknown; playbackReturnTo?: unknown } | null
  const returnTo = [routeState?.playbackReturnTo, routeState?.returnTo]
    .find((value): value is string => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//'))
  return (
    <Navigate
      replace
      to={`/play/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}/0/0`}
      state={{ playbackReturnTo: returnTo, autoPlay: true }}
    />
  )
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
