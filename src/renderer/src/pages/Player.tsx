import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { AppSettings, DanmakuCandidate, DanmakuCue } from '@shared/types'
import { EmptyState } from '@/components/EmptyState'
import { AiSummary } from '@/components/AiSummary'
import { Poster } from '@/components/Poster'
import { DanmakuCanvas } from '@/components/DanmakuCanvas'
import { DanmakuSettingsPanel } from '@/components/DanmakuSettingsPanel'
import { Icon } from '@/components/icons'
import { Switch } from '@/components/Switch'
import { detailKey, findSourceGroup, libraryKey, toFavoriteInput, useApp } from '@/store/useApp'
import { createVideoPlayer, seekVideoPlayer, type VideoPlayer } from '@/utils/videojs'
import { isDirectMedia, isHls, pickPlayableLine } from '@/utils/media'
import { formatClock } from '@/utils/format'
import { normalizeName } from '@/utils/normalize'
import { translate } from '@/i18n'

const DANMAKU_INITIAL_BATCH_SIZE = 500
const DANMAKU_APPEND_BATCH_SIZE = 1000
const DANMAKU_APPEND_INTERVAL_MS = 50
const SKIP_MARKER_LONG_PRESS_MS = 500
const FULLSCREEN_CONTROL_HOVER_HEIGHT = 112
const FULLSCREEN_PAUSE_PEEK_MS = 1000
const FULLSCREEN_PLAY_IDLE_MS = 3200
const PLAYER_SKIP_MARKERS_STORAGE_KEY = 'cc-tv.player-skip-markers.v2'
const LEGACY_PLAYER_SKIP_MARKERS_STORAGE_KEY = 'cc-tv.player-skip-markers.v1'

type SkipMarkerKey = 'introSkipSeconds' | 'outroSkipAtSeconds'
type SavedSkipMarkers = Record<string, Partial<Record<SkipMarkerKey, number>>>
type LegacySkipMarkers = Record<string, Partial<Record<'introSkipSeconds' | 'outroSkipSeconds', number>>>

function readSkipMarkers(): SavedSkipMarkers {
  try {
    const value = localStorage.getItem(PLAYER_SKIP_MARKERS_STORAGE_KEY)
    const parsed: unknown = value ? JSON.parse(value) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, marker]) => {
      if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return []
      const valid = Object.fromEntries((['introSkipSeconds', 'outroSkipAtSeconds'] as const).flatMap((field) => {
        const seconds = (marker as Record<string, unknown>)[field]
        return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? [[field, Math.floor(seconds)]] : []
      }))
      return Object.keys(valid).length ? [[key, valid]] : []
    })) as SavedSkipMarkers
  } catch {
    return {}
  }
}

function readLegacySkipMarkers(): LegacySkipMarkers {
  try {
    const value = localStorage.getItem(LEGACY_PLAYER_SKIP_MARKERS_STORAGE_KEY)
    const parsed: unknown = value ? JSON.parse(value) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, marker]) => {
      if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return []
      const valid = Object.fromEntries((['introSkipSeconds', 'outroSkipSeconds'] as const).flatMap((field) => {
        const seconds = (marker as Record<string, unknown>)[field]
        return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? [[field, Math.floor(seconds)]] : []
      }))
      return Object.keys(valid).length ? [[key, valid]] : []
    })) as LegacySkipMarkers
  } catch {
    return {}
  }
}

function formatMarkerTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const remainder = value % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

export function Player({
  visible = true,
  autoPlay = visible
}: {
  visible?: boolean
  autoPlay?: boolean
}): JSX.Element {
  const params = useParams()
  const siteKey = params.siteKey ?? ''
  const vodId = params.vodId ?? ''
  const lineIndex = Number(params.lineIndex ?? 0) || 0
  const epIndex = Number(params.epIndex ?? 0) || 0

  const location = useLocation()
  const navigate = useNavigate()
  const routeState = location.state as { playbackReturnTo?: unknown } | null
  const playbackReturnTo = typeof routeState?.playbackReturnTo === 'string' &&
    routeState.playbackReturnTo.startsWith('/') && !routeState.playbackReturnTo.startsWith('//')
    ? routeState.playbackReturnTo
    : null
  const playerRouteState = useMemo(() => ({
    ...(location.state && typeof location.state === 'object' && !Array.isArray(location.state)
      ? location.state as Record<string, unknown>
      : {}),
    ...(playbackReturnTo ? { playbackReturnTo } : {})
  }), [location.state, playbackReturnTo])
  const navigatePlayerRoute = useCallback((pathname: string, replace = false): void => {
    if (!visible) return
    navigate(pathname, { replace, state: playerRouteState })
  }, [navigate, playerRouteState, visible])
  const navigateToEpisode = useCallback((index: number): void => {
    navigatePlayerRoute(`/play/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}/${lineIndex}/${index}`)
  }, [navigatePlayerRoute, siteKey, vodId, lineIndex])
  const navigateToLine = useCallback((index: number): void => {
    navigatePlayerRoute(`/play/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}/${index}/0`)
  }, [navigatePlayerRoute, siteKey, vodId])
  const sites = useApp((s) => s.sites)
  const details = useApp((s) => s.details)
  const history = useApp((s) => s.history)
  const favorites = useApp((s) => s.favorites)
  const loadDetail = useApp((s) => s.loadDetail)
  const settings = useApp((s) => s.settings)
  const notify = useApp((s) => s.notify)
  const updateSettings = useApp((s) => s.updateSettings)
  const searchResults = useApp((s) => s.search.results)
  const searchKeyword = useApp((s) => s.search.wd)
  const searchRunning = useApp((s) => s.search.running)
  const runSearch = useApp((s) => s.runSearch)
  const recordHistory = useApp((s) => s.recordHistory)
  const toggleFavorite = useApp((s) => s.toggleFavorite)
  const filterCommentary = settings?.filterCommentary ?? true

  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const progressPreviewContainerRef = useRef<HTMLDivElement>(null)
  const pointerInsidePlayer = useRef(false)
  const playerRef = useRef<VideoPlayer | null>(null)
  const visibleRef = useRef(visible)
  const autoplayRef = useRef(visible && autoPlay)
  const playerRouteKey = `${siteKey}::${vodId}::${lineIndex}::${epIndex}`
  const previousPlayerRouteKey = useRef(playerRouteKey)
  visibleRef.current = visible
  const backFromPlayer = useCallback((): void => {
    playerRef.current?.pause()
    navigate(playbackReturnTo ?? '/play', {
      replace: true,
      state: { ...playerRouteState, clearPlayer: true }
    })
  }, [navigate, playbackReturnTo, playerRouteState])
  const previewPlayerRef = useRef<VideoPlayer | null>(null)
  const previewSourceKeyRef = useRef('')
  const previewSeekTargetRef = useRef(0)
  const previewSeekTimerRef = useRef<number | undefined>(undefined)
  const previewHideTimerRef = useRef<number | undefined>(undefined)
  const previewSeekedAtRef = useRef(0)
  const previewHoveringRef = useRef(false)
  const previewPlayerErroredRef = useRef(false)
  const previewLastXRef = useRef(0)
  const heldPlaybackRateRef = useRef<{
    player: VideoPlayer
    rate: number
    wasPlaying: boolean
    startedAt: number
    activated: boolean
    timer: number | undefined
  } | null>(null)
  const suppressHoldClickRef = useRef(false)
  const autoFindSourcesKey = useRef('')
  const danmakuSequence = useRef(0)
  const danmakuBatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [activePlayer, setActivePlayer] = useState<VideoPlayer | null>(null)

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [hint, setHint] = useState('')
  const [finding, setFinding] = useState(false)
  /** 正在向解析接口换地址 */
  const [resolving, setResolving] = useState(false)
  /** 这一次是靠哪条路换出的地址，或者为什么没换出来 */
  const [resolveNote, setResolveNote] = useState('')
  const [favoriteBusy, setFavoriteBusy] = useState(false)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [danmakuCandidates, setDanmakuCandidates] = useState<DanmakuCandidate[]>([])
  const [danmakuCues, setDanmakuCues] = useState<DanmakuCue[]>([])
  const [selectedDanmaku, setSelectedDanmaku] = useState('')
  const [danmakuMessage, setDanmakuMessage] = useState('')
  const [showDanmaku, setShowDanmaku] = useState(settings?.danmakuEnabled ?? true)
  const [showDanmakuSettings, setShowDanmakuSettings] = useState(false)
  const [showPlayerSettings, setShowPlayerSettings] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [playerControlsVisible, setPlayerControlsVisible] = useState(false)
  const [showEpisodePicker, setShowEpisodePicker] = useState(false)
  const [showCachePicker, setShowCachePicker] = useState(false)
  const [cacheSelection, setCacheSelection] = useState<number[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackPosition, setPlaybackPosition] = useState(0)
  const [playbackDuration, setPlaybackDuration] = useState(0)
  const [progressPreview, setProgressPreview] = useState<{ seconds: number; x: number } | null>(null)
  const [playbackSource, setPlaybackSource] = useState<{ url: string; hls: boolean } | null>(null)
  const [previewFrameReady, setPreviewFrameReady] = useState(false)
  const [systemClock, setSystemClock] = useState(() => new Date())
  const [legacySkipMarkers] = useState<LegacySkipMarkers>(readLegacySkipMarkers)
  const legacySkipMarkersRef = useRef(legacySkipMarkers)
  legacySkipMarkersRef.current = legacySkipMarkers
  const migratedSkipMarkersRef = useRef(new Set<string>())
  const resumeRecord = useMemo(() => history
    .flatMap((group) => group.items)
    .find((item) => item.siteKey === siteKey && item.vodId === vodId && item.lineIndex === lineIndex && item.epIndex === epIndex),
  [history, siteKey, vodId, lineIndex, epIndex])
  const resumeRecordRef = useRef(resumeRecord)
  resumeRecordRef.current = resumeRecord
  const resumeApplied = useRef(false)

  const cancelDanmakuBatches = useCallback((): void => {
    if (danmakuBatchTimer.current !== null) {
      clearTimeout(danmakuBatchTimer.current)
      danmakuBatchTimer.current = null
    }
  }, [])

  const displayDanmakuProgressively = useCallback((
    cues: DanmakuCue[],
    isCurrent: () => boolean
  ): void => {
    cancelDanmakuBatches()
    const firstEnd = Math.min(DANMAKU_INITIAL_BATCH_SIZE, cues.length)
    setDanmakuCues(cues.slice(0, firstEnd))
    if (cues.length <= firstEnd) {
      setDanmakuMessage(`${cues.length} 条弹幕`)
      return
    }

    setDanmakuMessage(`正在渲染弹幕 ${firstEnd}/${cues.length} 条…`)
    const append = (offset: number): void => {
      danmakuBatchTimer.current = null
      if (!isCurrent()) return
      const end = Math.min(cues.length, offset + DANMAKU_APPEND_BATCH_SIZE)
      setDanmakuCues((current) => [...current, ...cues.slice(offset, end)])
      if (end < cues.length) {
        setDanmakuMessage(`正在渲染弹幕 ${end}/${cues.length} 条…`)
        danmakuBatchTimer.current = setTimeout(() => append(end), DANMAKU_APPEND_INTERVAL_MS)
      } else {
        setDanmakuMessage(`${cues.length} 条弹幕`)
      }
    }
    danmakuBatchTimer.current = setTimeout(() => append(firstEnd), DANMAKU_APPEND_INTERVAL_MS)
  }, [cancelDanmakuBatches])
  const [playbackRate, setPlaybackRate] = useState(1)
  const [cacheBusy, setCacheBusy] = useState(false)
  const [savedSkipMarkers, setSavedSkipMarkers] = useState<SavedSkipMarkers>(readSkipMarkers)
  const savedSkipMarkersRef = useRef(savedSkipMarkers)
  savedSkipMarkersRef.current = savedSkipMarkers
  const introApplied = useRef(false)
  const outroTriggered = useRef(false)
  const nextEpisodeRef = useRef(-1)
  const navigateEpisodeRef = useRef(navigateToEpisode)
  const fullscreenTimer = useRef<number | undefined>(undefined)

  const clearFullscreenTimer = useCallback((): void => {
    if (fullscreenTimer.current === undefined) return
    window.clearTimeout(fullscreenTimer.current)
    fullscreenTimer.current = undefined
  }, [])

  const scheduleFullscreenHide = useCallback((delay: number): void => {
    clearFullscreenTimer()
    fullscreenTimer.current = window.setTimeout(() => {
      fullscreenTimer.current = undefined
      setPlayerControlsVisible(false)
    }, delay)
  }, [clearFullscreenTimer])

  const detail = details[detailKey(siteKey, vodId)]
  const favorited = favorites.some((favorite) => libraryKey(favorite.siteKey, favorite.vodId) === libraryKey(siteKey, vodId))
  const description = detail?.vod_content.replace(/(?:&amp;nbsp;|&nbsp;|&#160;|&#x0*a0;|\u00a0)/gi, ' ').trim() ?? ''
  const cachePoster = useMemo(() => detail?.vod_pic || searchResults
    .flatMap((result) => result.list)
    .find((vod) => normalizeName(vod.vod_name) === normalizeName(detail?.vod_name ?? '') && vod.vod_pic)
    ?.vod_pic || '', [detail?.vod_name, detail?.vod_pic, searchResults])
  const skipMarkerKey = `${siteKey}::${vodId}`
  const savedOutroMarker = savedSkipMarkers[skipMarkerKey]
  const hasSavedOutroMarker = savedOutroMarker && Object.prototype.hasOwnProperty.call(savedOutroMarker, 'outroSkipAtSeconds')
  const currentSkipMarkers = {
    introSkipSeconds: savedSkipMarkers[skipMarkerKey]?.introSkipSeconds ??
      legacySkipMarkers[skipMarkerKey]?.introSkipSeconds ?? settings?.introSkipSeconds ?? 0,
    outroSkipAtSeconds: savedOutroMarker?.outroSkipAtSeconds ?? 0,
    outroAutoSwitchSeconds: hasSavedOutroMarker ? 0 : settings?.outroSkipSeconds ?? 0
  }
  const currentSkipMarkersRef = useRef(currentSkipMarkers)
  currentSkipMarkersRef.current = currentSkipMarkers
  const site = sites.find((s) => s.key === siteKey)
  const line = detail?.lines[lineIndex]
  const episodes = line?.episodes ?? []
  const episode = line?.episodes[epIndex]
  const danmakuRequestId = `${siteKey}\u001f${vodId}\u001f${lineIndex}\u001f${epIndex}`
  nextEpisodeRef.current = epIndex < (line?.episodes.length ?? 0) - 1 ? epIndex + 1 : -1
  navigateEpisodeRef.current = navigateToEpisode

  const updateSkipMarker = useCallback((key: SkipMarkerKey, value: number): void => {
    setSavedSkipMarkers((current) => {
      const next = {
        ...current,
        [skipMarkerKey]: { ...current[skipMarkerKey], [key]: value }
      }
      return next
    })
  }, [skipMarkerKey])

  useEffect(() => {
    try {
      localStorage.setItem(PLAYER_SKIP_MARKERS_STORAGE_KEY, JSON.stringify(savedSkipMarkers))
    } catch {
      notify(translate('片头片尾标记无法保存到本机'), 'danger')
    }
  }, [savedSkipMarkers, notify])

  const clearSkipMarker = useCallback((key: SkipMarkerKey): void => {
    updateSkipMarker(key, 0)
    notify(`${key === 'introSkipSeconds' ? '片头' : '片尾'}标记已清除`, 'success')
  }, [notify, updateSkipMarker])

  const markSkipPosition = useCallback((key: SkipMarkerKey): void => {
    const player = playerRef.current
    const duration = player?.duration()
    const currentTime = player?.currentTime()
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 ||
      typeof currentTime !== 'number' || !Number.isFinite(currentTime)) {
      notify(translate('视频时长尚未读取，暂时不能标记'), 'danger')
      return
    }

    const isIntro = key === 'introSkipSeconds'
    if ((isIntro && currentTime > duration / 2) || (!isIntro && currentTime < duration / 2)) {
      notify(translate(isIntro ? '片头标记需位于视频前半段' : '片尾标记需位于视频后半段'), 'danger')
      return
    }

    const seconds = Math.floor(currentTime)
    const markerKey = isIntro ? 'introSkipSeconds' : 'outroSkipAtSeconds'
    updateSkipMarker(markerKey, seconds)
    notify(`${translate(isIntro ? '片头' : '片尾')}${translate('已标记：')}${formatMarkerTime(seconds)}`, 'success')
  }, [notify, updateSkipMarker])

  const toggleFullscreen = useCallback(async (): Promise<void> => {
    const stage = stageRef.current
    if (!stage) return
    try {
      if (document.fullscreenElement === stage) await document.exitFullscreen()
      else await stage.requestFullscreen()
    } catch (error) {
      notify(`${translate('无法进入全屏：')}${(error as Error).message}`, 'danger')
    }
  }, [notify])

  useEffect(() => {
    const update = (): void => {
      const active = document.fullscreenElement === stageRef.current
      clearFullscreenTimer()
      setIsFullscreen(active)
      setPlayerControlsVisible(true)
      previewHoveringRef.current = false
      setProgressPreview(null)
      setShowDanmakuSettings(false)
      setShowPlayerSettings(false)
      setShowEpisodePicker(false)
      setShowCachePicker(false)
    }
    document.addEventListener('fullscreenchange', update)
    return () => {
      document.removeEventListener('fullscreenchange', update)
      clearFullscreenTimer()
    }
  }, [clearFullscreenTimer])

  useEffect(() => {
    const timer = window.setInterval(() => setSystemClock(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setShowEpisodePicker(false)
    setShowCachePicker(false)
    setCacheSelection([])
    setShowDanmakuSettings(false)
    setShowPlayerSettings(false)
  }, [siteKey, vodId, lineIndex, epIndex])

  useEffect(() => {
    if (!showDanmakuSettings && !showPlayerSettings && !showEpisodePicker && !showCachePicker) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setShowDanmakuSettings(false)
        setShowPlayerSettings(false)
        setShowEpisodePicker(false)
        setShowCachePicker(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showDanmakuSettings, showPlayerSettings, showEpisodePicker, showCachePicker])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    loadDetail(siteKey, vodId)
      .then(() => {
        if (alive) setLoading(false)
      })
      .catch((err: Error) => {
        if (alive) {
          setError(err.message)
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [siteKey, vodId, loadDetail])

  // 换集时先销毁旧实例，避免前一集的媒体请求和音轨继续播放。
  //
  // 很多采集站的线路给的不是直链，而是一个分享页地址（素博的 subyun 线路就是
  // https://play.xluuss.com/play/nelOoxJd 这种）。这种地址直接丢给播放器只会报错，
  // 所以先让主进程解析一遍：它通常自己读一遍那个页面就能拿到 m3u8，读不出来才问解析接口。
  useEffect(() => {
    const heldRate = heldPlaybackRateRef.current
    heldPlaybackRateRef.current = null
    if (heldRate && !heldRate.player.isDisposed()) heldRate.player.playbackRate(heldRate.rate)
    const el = containerRef.current
    if (!el || !episode) return
    el.innerHTML = ''
    setHint('')
    setError('')
    setResolving(false)
    setResolveNote('')
    setIsPlaying(false)
    setPlaybackPosition(0)
    setPlaybackDuration(0)
    setPlaybackSource(null)
    setProgressPreview(null)
    setPreviewFrameReady(false)
    setPlaybackRate(1)
    introApplied.current = false
    outroTriggered.current = false
    resumeApplied.current = false

    let alive = true
    const playerBox: { current: VideoPlayer | null } = { current: null }
    let lastSaved = 0
    const raw = episode.url

    // 观看记录：进播放页就先记一条（position 0），之后由 timeupdate 定时刷新进度。
    // 用 5 秒节流，否则 timeupdate 每 250ms 触发一次会把 store 和磁盘写爆。
    const save = (force = false): void => {
      const player = playerBox.current
      if (!player) return
      const now = Date.now()
      if (!force && now - lastSaved < 5000) return
      lastSaved = now
      void recordHistory({
        siteKey,
        siteName: site?.name ?? siteKey,
        vodId,
        name: detail?.vod_name ?? siteKey,
        pic: detail?.vod_pic,
        lineIndex,
        epIndex,
        epName: episode.name,
        position: Math.floor(player.currentTime() || 0),
        duration: Number.isFinite(player.duration()) ? Math.floor(player.duration() || 0) : 0
      })
    }

    const mount = (url: string, hls: boolean): void => {
      setPlaybackSource({ url, hls })
      const player = createVideoPlayer(el, {
        url,
        accent: settings?.accent,
        hls,
        autoplay: visibleRef.current && autoplayRef.current,
        bigPlayButton: false,
        toggleFullscreen: () => { void toggleFullscreen() }
      })
      playerBox.current = player
      playerRef.current = player
      setActivePlayer(player)
      player.on('error', () => {
        setError(translate('视频加载失败，可能是地址已失效、需要 Referer，或者需要解析接口。'))
      })
      player.one('canplay', () => {
        if (!visibleRef.current || !autoplayRef.current || !player.paused()) return
        void Promise.resolve(player.play()).catch(() => {
          if (alive && visibleRef.current) setHint(translate('自动播放被系统拦截，请点击播放器播放'))
        })
      })
      player.on('loadedmetadata', () => {
        const duration = player.duration()
        setPlaybackDuration(typeof duration === 'number' && Number.isFinite(duration) ? duration : 0)
        if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0 &&
          !migratedSkipMarkersRef.current.has(skipMarkerKey)) {
          migratedSkipMarkersRef.current.add(skipMarkerKey)
          const legacyOutroSeconds = legacySkipMarkersRef.current[skipMarkerKey]?.outroSkipSeconds ?? 0
          const savedMarker = savedSkipMarkersRef.current[skipMarkerKey]
          const hasOutroMarker = savedMarker && Object.prototype.hasOwnProperty.call(savedMarker, 'outroSkipAtSeconds')
          if (!hasOutroMarker && legacyOutroSeconds > 0 && legacyOutroSeconds < duration) {
            const outroAtSeconds = Math.floor(duration - legacyOutroSeconds)
            setSavedSkipMarkers((current) => ({
              ...current,
              [skipMarkerKey]: { ...current[skipMarkerKey], outroSkipAtSeconds: outroAtSeconds }
            }))
          }
        }
        const previous = resumeRecordRef.current
        if (!resumeApplied.current) {
          resumeApplied.current = true
          const position = previous?.position ?? 0
          if (position > 1 && typeof duration === 'number' && Number.isFinite(duration) && duration > 1) {
            const target = Math.min(position, duration - 0.5)
            player.currentTime(target)
            setPlaybackPosition(target)
            introApplied.current = true
            return
          }
        }
        const skip = currentSkipMarkersRef.current.introSkipSeconds
        if (!introApplied.current && skip > 0 && typeof duration === 'number' && Number.isFinite(duration) && duration > skip + 2) {
          introApplied.current = true
          player.currentTime(skip)
        }
      })
      player.on('ratechange', () => setPlaybackRate(player.playbackRate() || 1))
      player.on('play', () => {
        setIsPlaying(true)
        clearFullscreenTimer()
        if (document.fullscreenElement === stageRef.current) scheduleFullscreenHide(FULLSCREEN_PLAY_IDLE_MS)
      })
      player.on('playing', () => {
        setIsPlaying(true)
      })
      player.on('pause', () => {
        setIsPlaying(false)
        if (document.fullscreenElement !== stageRef.current) return
        setPlayerControlsVisible(true)
        scheduleFullscreenHide(FULLSCREEN_PAUSE_PEEK_MS)
      })
      const updatePlaybackClock = (): void => {
        const position = player.currentTime()
        const duration = player.duration()
        setPlaybackPosition(typeof position === 'number' && Number.isFinite(position) ? position : 0)
        setPlaybackDuration(typeof duration === 'number' && Number.isFinite(duration) ? duration : 0)
      }
      player.on('durationchange', updatePlaybackClock)
      save(true)
      player.on('timeupdate', () => {
        updatePlaybackClock()
        save()
        const duration = player.duration()
        const currentTime = player.currentTime()
        const outroAt = currentSkipMarkersRef.current.outroSkipAtSeconds
        const autoSwitchSeconds = currentSkipMarkersRef.current.outroAutoSwitchSeconds
        const outroReached = typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime > 0 &&
          (outroAt > 0
            ? currentTime >= outroAt
            : autoSwitchSeconds > 0 && typeof duration === 'number' && Number.isFinite(duration) &&
              duration - currentTime <= autoSwitchSeconds)
        if (visibleRef.current && !outroTriggered.current && nextEpisodeRef.current >= 0 &&
          typeof duration === 'number' && Number.isFinite(duration) && duration > 0 &&
          outroReached) {
          outroTriggered.current = true
          navigateEpisodeRef.current(nextEpisodeRef.current)
        }
      })
      player.on('pause', () => save(true))
      player.on('ended', () => save(true))
    }

    const boot = async (): Promise<void> => {
      setResolving(true)
      try {
        const r = await window.api.player.resolveEpisode(siteKey, raw)
        if (!alive) return
        const notes = []
        if (r.sourceUrl !== raw) notes.push(translate('已解析播放地址'))
        if (isHls(r.sourceUrl) && r.purifyEnabled) notes.push(translate('M3U8 净化已开启'))
        setResolveNote(notes.join(' · ') || translate('直连播放'))
        mount(r.url, isHls(r.sourceUrl))
      } catch (err) {
        if (alive) setError((err as Error).message)
      } finally {
        if (alive) setResolving(false)
      }
    }
    void boot()

    return () => {
      alive = false
      playerRef.current = null
      setActivePlayer(null)
      playerBox.current?.dispose()
    }
    // 依赖只留 url / accent：把 detail 的字段放进依赖会让详情加载完成后
    // 重建播放器实例，正在播的流会被打断。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode?.url, settings?.accent, siteKey, toggleFullscreen, clearFullscreenTimer, scheduleFullscreenHide])

  useEffect(() => {
    setShowDanmaku(settings?.danmakuEnabled ?? true)
  }, [settings?.danmakuEnabled])

  useEffect(() => {
    let alive = true
    const sequence = ++danmakuSequence.current
    const isCurrent = (): boolean => alive && danmakuSequence.current === sequence
    cancelDanmakuBatches()
    if (!episode || !detail || !settings?.danmakuEnabled) {
      setDanmakuCandidates([])
      setDanmakuCues([])
      setSelectedDanmaku('')
      setDanmakuMessage(settings?.danmakuEnabled === false
        ? translate('自动弹幕已关闭')
        : '')
      void window.api.danmaku.cancel(danmakuRequestId)
      return () => { alive = false }
    }
    setDanmakuCandidates([])
    setDanmakuCues([])
    setSelectedDanmaku('')
    setDanmakuMessage(translate('正在匹配弹幕…'))
    void (async () => {
      try {
        const items = await window.api.danmaku.search(detail.vod_name, episode.name, danmakuRequestId)
        if (!isCurrent()) return
        setDanmakuCandidates(items)
        if (!items.length) {
          setDanmakuMessage(translate('没有匹配到弹幕'))
          return
        }

        const candidates = items.slice(0, 8)
        let lastError: Error | undefined
        for (let index = 0; index < candidates.length; index++) {
          const candidate = candidates[index]
          if (!isCurrent()) return
          setSelectedDanmaku(candidate.id)
          setDanmakuMessage(candidates.length > 1
            ? `正在加载匹配项 ${index + 1}/${candidates.length}…`
            : translate('正在加载弹幕…'))
          try {
            const cues = await window.api.danmaku.load(candidate.id, danmakuRequestId, candidate.cacheKey)
            if (!isCurrent()) return
            if (!cues.length) continue
            displayDanmakuProgressively(cues, isCurrent)
            return
          } catch (error) {
            if (!isCurrent()) return
            lastError = error as Error
          }
        }
        setSelectedDanmaku('')
        setDanmakuMessage(lastError ? `${translate('弹幕加载失败：')}${lastError.message}` : translate('匹配项暂无弹幕'))
      } catch (error) {
        if (isCurrent()) setDanmakuMessage((error as Error).message)
      }
    })()
    return () => {
      alive = false
      cancelDanmakuBatches()
      if (danmakuSequence.current === sequence) danmakuSequence.current++
      void window.api.danmaku.cancel(danmakuRequestId)
    }
  }, [siteKey, vodId, lineIndex, epIndex, detail?.vod_name, episode?.name, settings?.danmakuEnabled, danmakuRequestId, cancelDanmakuBatches, displayDanmakuProgressively])

  const cacheSelectedEpisodes = useCallback(async (): Promise<void> => {
    if (!detail || !cacheSelection.length) return
    setCacheBusy(true)
    try {
      let added = 0
      for (const index of [...cacheSelection].sort((a, b) => a - b)) {
        const item = episodes[index]
        if (!item) continue
        await window.api.offline.add({
          siteKey,
          siteName: site?.name ?? siteKey,
          vodId,
          movieName: detail.vod_name,
          episodeName: item.name,
          episodeIndex: index,
          lineIndex,
          pic: cachePoster,
          rawUrl: item.url
        })
        added++
      }
      setShowCachePicker(false)
      setCacheSelection([])
      notify(`已加入 ${added} 集离线缓存`, 'success')
    } catch (error) {
      notify((error as Error).message, 'danger')
    } finally {
      setCacheBusy(false)
    }
  }, [cacheSelection, detail, episodes, lineIndex, cachePoster, siteKey, site?.name, vodId, notify])

  const toggleDanmaku = useCallback((): void => {
    const enabled = !showDanmaku
    setShowDanmaku(enabled)
    if (!enabled) {
      danmakuSequence.current++
      cancelDanmakuBatches()
      void window.api.danmaku.cancel(danmakuRequestId)
    }
    void updateSettings({ danmakuEnabled: enabled })
  }, [showDanmaku, updateSettings, cancelDanmakuBatches, danmakuRequestId])

  const cyclePlaybackRate = useCallback((): void => {
    const rates = [0.75, 1, 1.25, 1.5, 2, 3]
    const current = activePlayer?.playbackRate() || playbackRate
    const currentIndex = rates.indexOf(current)
    const rate = rates[(currentIndex + 1 + rates.length) % rates.length]
    activePlayer?.playbackRate(rate)
    setPlaybackRate(rate)
  }, [activePlayer, playbackRate])

  const togglePlayback = useCallback((): void => {
    if (!activePlayer) return
    if (activePlayer.paused()) void activePlayer.play()
    else activePlayer.pause()
  }, [activePlayer])

  const restoreHeldPlaybackRate = useCallback((resumePlayback = true): void => {
    const held = heldPlaybackRateRef.current
    if (!held) return
    heldPlaybackRateRef.current = null
    if (held.timer !== undefined) window.clearTimeout(held.timer)
    if (held.activated) {
      suppressHoldClickRef.current = true
      window.setTimeout(() => { suppressHoldClickRef.current = false }, 500)
    }
    if (held.player.isDisposed()) return
    held.player.playbackRate(held.rate)
    if (held.player === playerRef.current) setPlaybackRate(held.rate)
    if (resumePlayback && (held.wasPlaying || held.activated) && held.player.paused()) {
      void Promise.resolve(held.player.play()).catch(() => undefined)
    }
  }, [])

  const wasVisible = useRef(visible)
  useEffect(() => {
    const routeChanged = previousPlayerRouteKey.current !== playerRouteKey
    previousPlayerRouteKey.current = playerRouteKey
    const wasPlayerVisible = wasVisible.current
    wasVisible.current = visible
    const player = playerRef.current
    if (!visible) {
      autoplayRef.current = false
      restoreHeldPlaybackRate(false)
      player?.pause()
      return
    }
    const shouldAutoplay = autoPlay
    if (routeChanged) {
      autoplayRef.current = shouldAutoplay
      if (shouldAutoplay && player?.paused()) {
        void Promise.resolve(player.play()).catch(() => undefined)
      }
      return
    }
    if (wasPlayerVisible) return

    autoplayRef.current = shouldAutoplay
    if (shouldAutoplay && player?.paused()) {
      void Promise.resolve(player.play()).catch(() => undefined)
    }
  }, [autoPlay, visible, playerRouteKey, restoreHeldPlaybackRate])

  const startHeldPlaybackRate = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || heldPlaybackRateRef.current || !activePlayer) return
    const target = event.target
    if (target instanceof Element && target.closest('button, input, select, .vjs-control, .danmaku-settings-backdrop')) return
    const rate = activePlayer.playbackRate() || 1
    const held = {
      player: activePlayer,
      rate,
      wasPlaying: !activePlayer.paused(),
      startedAt: Date.now(),
      activated: false,
      timer: undefined as number | undefined
    }
    held.timer = window.setTimeout(() => {
      if (heldPlaybackRateRef.current !== held || activePlayer.isDisposed()) return
      held.activated = true
      activePlayer.playbackRate(3)
      setPlaybackRate(3)
      if (activePlayer.paused()) void Promise.resolve(activePlayer.play()).catch(() => undefined)
    }, 250)
    heldPlaybackRateRef.current = held
    event.preventDefault()
  }, [activePlayer])

  useEffect(() => {
    const restore = (): void => restoreHeldPlaybackRate()
    const onVisibilityChange = (): void => {
      if (document.hidden) restore()
    }
    window.addEventListener('pointerup', restore)
    window.addEventListener('pointercancel', restore)
    window.addEventListener('blur', restore)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pointerup', restore)
      window.removeEventListener('pointercancel', restore)
      window.removeEventListener('blur', restore)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      restore()
    }
  }, [restoreHeldPlaybackRate])

  useEffect(() => {
    const isTextInput = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false
      return target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!visible || !pointerInsidePlayer.current || showDanmakuSettings || showPlayerSettings || showEpisodePicker || showCachePicker) return
      if (event.altKey || event.ctrlKey || event.metaKey || isTextInput(event.target) || isTextInput(document.activeElement)) return

      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.repeat) togglePlayback()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.repeat) void toggleFullscreen()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [visible, showCachePicker, showDanmakuSettings, showPlayerSettings, showEpisodePicker, toggleFullscreen, togglePlayback])

  const seekPreviewFrame = useCallback((seconds: number): void => {
    const previewPlayer = previewPlayerRef.current
    if (!previewPlayer || previewPlayer.isDisposed() || previewPlayer.readyState() < 1) return
    try {
      previewPlayer.currentTime(seconds)
    } catch {
      // Some encrypted streams do not support seeking in a second player.
    }
  }, [])

  const schedulePreviewSeek = useCallback((seconds: number): void => {
    previewSeekTargetRef.current = seconds
    setPreviewFrameReady(false)
    const elapsed = performance.now() - previewSeekedAtRef.current
    const run = (): void => {
      previewSeekTimerRef.current = undefined
      previewSeekedAtRef.current = performance.now()
      seekPreviewFrame(previewSeekTargetRef.current)
    }

    if (elapsed >= 50) {
      if (previewSeekTimerRef.current !== undefined) {
        window.clearTimeout(previewSeekTimerRef.current)
        previewSeekTimerRef.current = undefined
      }
      run()
    } else if (previewSeekTimerRef.current === undefined) {
      previewSeekTimerRef.current = window.setTimeout(run, 50 - elapsed)
    }
  }, [seekPreviewFrame])

  const updateProgressPreviewAt = useCallback((clientX: number, bounds: DOMRect): void => {
    if (playbackDuration <= 0 || bounds.width <= 0) return
    const stageBounds = stageRef.current?.getBoundingClientRect()
    if (!stageBounds) return
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width))
    const seconds = Math.min(Math.max(0, playbackDuration - 0.25), playbackDuration * ratio)
    const halfCardWidth = 90
    const x = Math.max(halfCardWidth, Math.min(stageBounds.width - halfCardWidth, clientX - stageBounds.left))
    if (previewHideTimerRef.current !== undefined) {
      window.clearTimeout(previewHideTimerRef.current)
      previewHideTimerRef.current = undefined
    }
    if (!previewHoveringRef.current && previewPlayerErroredRef.current) {
      const failedPlayer = previewPlayerRef.current
      if (failedPlayer && !failedPlayer.isDisposed()) failedPlayer.dispose()
      previewPlayerRef.current = null
      previewSourceKeyRef.current = ''
      previewPlayerErroredRef.current = false
    }
    previewHoveringRef.current = true
    previewLastXRef.current = x
    setPreviewFrameReady(false)
    setProgressPreview({ seconds, x })
  }, [playbackDuration])

  const clearProgressPreview = useCallback((): void => {
    if (previewHideTimerRef.current !== undefined) {
      window.clearTimeout(previewHideTimerRef.current)
      previewHideTimerRef.current = undefined
    }
    previewHoveringRef.current = false
    if (previewSeekTimerRef.current !== undefined) {
      window.clearTimeout(previewSeekTimerRef.current)
      previewSeekTimerRef.current = undefined
    }
    setPreviewFrameReady(false)
    setProgressPreview(null)
  }, [])

  const hideProgressPreview = useCallback((): void => {
    if (previewHideTimerRef.current !== undefined) window.clearTimeout(previewHideTimerRef.current)
    previewHideTimerRef.current = window.setTimeout(() => {
      previewHideTimerRef.current = undefined
      clearProgressPreview()
    }, 500)
  }, [clearProgressPreview])

  useEffect(() => {
    const progressControl = containerRef.current?.querySelector('.vjs-progress-control')
    const holder = containerRef.current?.querySelector('.vjs-progress-holder')
    const volumePanel = containerRef.current?.querySelector<HTMLElement>('.vjs-volume-panel')
    if (!(progressControl instanceof HTMLElement) || !(holder instanceof HTMLElement)) return
    const onMove = (event: PointerEvent): void => updateProgressPreviewAt(event.clientX, holder.getBoundingClientRect())
    const onLeave = (): void => hideProgressPreview()
    const onVolumeIntent = (): void => clearProgressPreview()
    const onVolumeWheel = (event: WheelEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      const direction = event.deltaY < 0 ? 1 : -1
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 3 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 1 : 100
      const steps = Math.max(1, Math.min(10, Math.round(Math.abs(event.deltaY) / unit)))
      const current = activePlayer?.volume() ?? 1
      const next = Math.max(0, Math.min(1, current + direction * steps * 0.05))
      if (direction > 0) activePlayer?.muted(false)
      activePlayer?.volume(next)
    }
    progressControl.addEventListener('pointerenter', onMove)
    progressControl.addEventListener('pointermove', onMove)
    progressControl.addEventListener('pointerleave', onLeave)
    volumePanel?.addEventListener('pointerenter', onVolumeIntent)
    volumePanel?.addEventListener('pointermove', onVolumeIntent)
    volumePanel?.addEventListener('wheel', onVolumeWheel, { passive: false })
    return () => {
      progressControl.removeEventListener('pointerenter', onMove)
      progressControl.removeEventListener('pointermove', onMove)
      progressControl.removeEventListener('pointerleave', onLeave)
      volumePanel?.removeEventListener('pointerenter', onVolumeIntent)
      volumePanel?.removeEventListener('pointermove', onVolumeIntent)
      volumePanel?.removeEventListener('wheel', onVolumeWheel)
    }
  }, [activePlayer, clearProgressPreview, hideProgressPreview, updateProgressPreviewAt])

  useEffect(() => {
    clearProgressPreview()
    setPreviewFrameReady(false)
    const sourceKey = playbackSource ? `${playbackSource.url}\u001f${playbackSource.hls}` : ''
    previewPlayerErroredRef.current = false
    if (previewPlayerRef.current && previewSourceKeyRef.current !== sourceKey) {
      previewPlayerRef.current.dispose()
      previewPlayerRef.current = null
      previewSourceKeyRef.current = ''
    }
  }, [clearProgressPreview, playbackSource?.url, playbackSource?.hls])

  useEffect(() => {
    if (!progressPreview || !playbackSource) return
    const host = progressPreviewContainerRef.current
    if (!host) return
    const sourceKey = `${playbackSource.url}\u001f${playbackSource.hls}`
    let previewPlayer = previewPlayerRef.current
    if (previewPlayer?.isDisposed()) {
      previewPlayer = null
      previewPlayerRef.current = null
      previewSourceKeyRef.current = ''
    }
    if (!previewPlayer) {
      previewPlayer = createVideoPlayer(host, {
        url: playbackSource.url,
        accent: settings?.accent,
        hls: playbackSource.hls,
        preview: true
      })
      previewPlayerRef.current = previewPlayer
      previewSourceKeyRef.current = sourceKey
      previewPlayer.on('loadedmetadata', () => schedulePreviewSeek(previewSeekTargetRef.current))
      const markFrameReady = (): void => {
        const current = Number(previewPlayer?.currentTime())
        if (previewHoveringRef.current && Number.isFinite(current) && Math.abs(current - previewSeekTargetRef.current) < 1.25) {
          setPreviewFrameReady(true)
        }
      }
      previewPlayer.on('loadeddata', markFrameReady)
      previewPlayer.on('seeked', markFrameReady)
      previewPlayer.on('error', () => {
        previewPlayerErroredRef.current = true
        setPreviewFrameReady(false)
      })
    }
    schedulePreviewSeek(progressPreview.seconds)
  }, [progressPreview, playbackSource, schedulePreviewSeek, settings?.accent])

  useEffect(() => () => {
    if (previewSeekTimerRef.current !== undefined) window.clearTimeout(previewSeekTimerRef.current)
    if (previewHideTimerRef.current !== undefined) window.clearTimeout(previewHideTimerRef.current)
    previewPlayerRef.current?.dispose()
    previewPlayerRef.current = null
  }, [])

  /**
   * 同一部影片的全部片源，用来在播放页直接换源。
   * 当前这条永远排第一个（即使它没出现在搜索结果里）。
   */
  const sources = useMemo(() => {
    if (!detail) return []
    const siteNames = new Map(sites.map((s) => [s.key, s.name]))
    return findSourceGroup(
      searchResults,
      { siteKey, vodId, vodName: detail.vod_name },
      siteNames,
      filterCommentary
    )
  }, [searchResults, detail, siteKey, vodId, sites, filterCommentary])

  /** 直接打开播放页（没走过搜索）时，按片名现搜一次来找其它片源 */
  const findSources = useCallback(async (): Promise<void> => {
    if (!detail?.vod_name) return
    setFinding(true)
    try {
      await runSearch(detail.vod_name)
    } finally {
      setFinding(false)
    }
  }, [detail?.vod_name, runSearch])

  useEffect(() => {
    if (!detail?.vod_name || sources.length > 1 || finding || searchRunning) return
    if (searchKeyword === detail.vod_name && searchResults.length) return
    const key = `${siteKey}::${vodId}`
    if (autoFindSourcesKey.current === key) return
    autoFindSourcesKey.current = key
    void findSources()
  }, [detail?.vod_name, sources.length, finding, searchRunning, searchKeyword, searchResults.length, siteKey, vodId, findSources])

  // 从别的片源切过来时链接只带 /0/0，而第 0 条线路常常是网页分享页。
  // 只在「第 0 线路 + 第 0 集 + 当前地址不是直链」时自动纠一次，
  // 用户自己选的线路不会被改掉。
  const autoFixed = useRef('')
  useEffect(() => {
    if (!detail || lineIndex !== 0 || epIndex !== 0) return
    const key = detailKey(siteKey, vodId)
    if (autoFixed.current === key) return
    if (isDirectMedia(detail.lines[0]?.episodes[0]?.url ?? '')) return
    const better = pickPlayableLine(detail.lines)
    if (better === 0) return
    autoFixed.current = key
    navigatePlayerRoute(`/play/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}/${better}/0`, true)
  }, [detail, lineIndex, epIndex, siteKey, vodId, navigatePlayerRoute])

  // 当前线路放不了、但另一条线路看起来是直链时，给一个一键切换的入口。
  // 这个 useMemo 必须在下面任何提前 return 之前，否则会打乱 hooks 顺序。
  const direct = isDirectMedia(episode?.url ?? '')
  const betterLine = useMemo(() => {
    if (direct || !detail) return -1
    const i = pickPlayableLine(detail.lines)
    return i !== lineIndex && isDirectMedia(detail.lines[i]?.episodes[0]?.url ?? '') ? i : -1
  }, [direct, detail, lineIndex])

  if (loading && !detail) {
    return (
      <div className="page">
        <div className="detail-loading">
          <span className="spin" />{translate("\n          正在准备播放…\n        ")}</div>
      </div>
    )
  }

  if (error && !detail) {
    return (
      <div className="page">
        <EmptyState
          icon={<Icon name="alert" size={26} />}
          title={translate("无法播放")}
          desc={error}
          actions={
            <button type="button" className="btn" onClick={backFromPlayer}>{translate("\n              返回\n            ")}</button>
          }
        />
      </div>
    )
  }

  if (!detail || !episode) {
    return (
      <div className="page">
        <EmptyState
          icon={<Icon name="screen-off" size={26} />}
          title={translate("找不到这一集")}
          desc="线路或剧集可能已经变更，请返回后重新选择。"
          actions={
            <button type="button" className="btn btn-primary" onClick={backFromPlayer}>
              {translate("\n              返回\n            ")}
            </button>
          }
        />
      </div>
    )
  }

  const prev = epIndex > 0 ? epIndex - 1 : -1
  const next = epIndex < episodes.length - 1 ? epIndex + 1 : -1
  const goTo = navigateToEpisode
  const fullscreenProgress = playbackDuration > 0
    ? Math.min(100, Math.max(0, playbackPosition / playbackDuration * 100))
    : 0
  const fullscreenTime = `${String(systemClock.getHours()).padStart(2, '0')}:${String(systemClock.getMinutes()).padStart(2, '0')}`

  const updateProgressPreview = (event: ReactPointerEvent<HTMLInputElement>): void => {
    updateProgressPreviewAt(event.clientX, event.currentTarget.getBoundingClientRect())
  }

  const updateControlsFromPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== 'mouse') {
      setPlayerControlsVisible(true)
      if (document.fullscreenElement === stageRef.current && activePlayer?.paused()) {
        scheduleFullscreenHide(FULLSCREEN_PAUSE_PEEK_MS)
      }
      return
    }

    if (document.fullscreenElement === stageRef.current) {
      const bounds = stageRef.current?.getBoundingClientRect()
      const inControls = Boolean(bounds && event.clientY >= bounds.bottom - FULLSCREEN_CONTROL_HOVER_HEIGHT)
      if (inControls) {
        setPlayerControlsVisible(true)
        if (activePlayer?.paused()) scheduleFullscreenHide(FULLSCREEN_PAUSE_PEEK_MS)
        else clearFullscreenTimer()
      } else {
        clearFullscreenTimer()
        setPlayerControlsVisible(false)
      }
      return
    }

    clearFullscreenTimer()
    setPlayerControlsVisible(true)
  }

  return (
    <div className="page page-player">
      <div className="detail-head">
        <button type="button" className="btn btn-sm" onClick={backFromPlayer}>
          <Icon name="chevron-left" size={14} />{translate(" 返回\n        ")}</button>
        <span className="detail-title-inline" title={detail.vod_name}>
          {detail.vod_name}
        </span>
        <span className="text-3 fs-12">
          {line?.name} · {episode.name}
        </span>
      </div>

      <div className="player-layout">
        <div className={`player-main${playerControlsVisible || showDanmakuSettings || showPlayerSettings || showEpisodePicker || showCachePicker ? '' : ' controls-hidden'}`}
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') pointerInsidePlayer.current = true
            updateControlsFromPointer(event)
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') {
              pointerInsidePlayer.current = false
              clearFullscreenTimer()
              setPlayerControlsVisible(false)
            }
          }}
          onPointerMove={updateControlsFromPointer}
          onPointerUp={(event) => {
            if (event.pointerType !== 'mouse') {
              scheduleFullscreenHide(activePlayer?.paused() ? FULLSCREEN_PAUSE_PEEK_MS : 3200)
            }
          }}
        >
          <div
            ref={stageRef}
            className={`player-stage${isFullscreen ? ' is-fullscreen' : ''}`}
            onPointerDown={startHeldPlaybackRate}
            onClickCapture={(event) => {
              if (!suppressHoldClickRef.current) return
              suppressHoldClickRef.current = false
              event.preventDefault()
              event.stopPropagation()
            }}
            onDoubleClick={(event) => {
              const target = event.target as HTMLElement
              if (target.closest('button, select, input, .vjs-control, .danmaku-settings-backdrop')) return
              void toggleFullscreen()
            }}
          >
            <div ref={containerRef} className="player-stage-inner" />
            <DanmakuCanvas
              player={activePlayer}
              cues={danmakuCues}
              visible={showDanmaku}
              maxLines={settings?.danmakuMaxLines ?? 3}
              speed={settings?.danmakuSpeed ?? 1}
              size={settings?.danmakuSize ?? 1.2}
              opacity={settings?.danmakuOpacity ?? 0.9}
              randomColor={settings?.danmakuRandomColor ?? true}
            />
            {isFullscreen ? (
              <div className={`player-fullscreen-controls${playerControlsVisible || showDanmakuSettings || showPlayerSettings || showEpisodePicker || showCachePicker ? ' visible' : ''}`}>
                <div className="player-fullscreen-title">
                  <span>{detail.vod_name}</span>
                  <span>{episode.name}{translate(" · 第 ")}{epIndex + 1} / {episodes.length}{translate(" 集")}</span>
                </div>
                <div className="player-fullscreen-bar">
                  <input
                    className="player-fullscreen-mini-progress"
                    type="range"
                    min={0}
                    max={Math.max(1, playbackDuration)}
                    step={1}
                    value={Math.min(playbackPosition, playbackDuration || 0)}
                    disabled={playbackDuration <= 0}
                    style={{ '--progress': `${fullscreenProgress}%` } as CSSProperties}
                    aria-label={translate("跳转播放进度")}
                    onPointerEnter={updateProgressPreview}
                    onPointerMove={updateProgressPreview}
                    onPointerLeave={hideProgressPreview}
                    onChange={(event) => {
                      const position = Number(event.currentTarget.value)
                      if (!activePlayer || !Number.isFinite(position)) return
                      seekVideoPlayer(activePlayer, position)
                      setPlaybackPosition(position)
                    }}
                  />
                  <button type="button" className="fullscreen-control fullscreen-icon-control" onClick={togglePlayback} title={isPlaying ? '暂停' : '播放'} aria-label={isPlaying ? '暂停' : '播放'}>
                    <Icon name={isPlaying ? 'pause' : 'play'} size={16} />
                  </button>
                  <time className="fullscreen-control fullscreen-playback-time" aria-label={translate("已播放时长和总时长")}>
                    {formatClock(playbackPosition)} / {playbackDuration > 0 ? formatClock(playbackDuration) : '--:--'}
                  </time>
                  <button type="button" className="fullscreen-control" disabled={prev < 0} onClick={() => goTo(prev)}>
                    <Icon name="chevron-left" size={16} />{translate(" 上一集\n                  ")}</button>
                  <button type="button" className="fullscreen-control" disabled={next < 0} onClick={() => goTo(next)}>{translate("\n                    下一集 ")}<Icon name="chevron-right" size={16} />
                  </button>
                  <div className="fullscreen-menu-anchor">
                    <button type="button" className={`fullscreen-control${showEpisodePicker ? ' active' : ''}`} onClick={() => setShowEpisodePicker(true)} aria-expanded={showEpisodePicker}>{translate("\n                      选集 ")}{epIndex + 1}/{episodes.length}
                    </button>
                  </div>
                  <button type="button" className="fullscreen-control" onClick={cyclePlaybackRate} title={translate("切换播放速度")}>{translate("\n                    倍速 ")}{playbackRate}x
                  </button>
                  <SkipMarkerButton label="片头" seconds={currentSkipMarkers.introSkipSeconds} className="fullscreen-control" onMark={() => markSkipPosition('introSkipSeconds')} onClear={() => clearSkipMarker('introSkipSeconds')} />
                  <SkipMarkerButton label="片尾" seconds={currentSkipMarkers.outroSkipAtSeconds} className="fullscreen-control" onMark={() => markSkipPosition('outroSkipAtSeconds')} onClear={() => clearSkipMarker('outroSkipAtSeconds')} />
                  <button type="button" className="fullscreen-control" onClick={toggleDanmaku}>
                    {showDanmaku ? '关闭弹幕' : '开启弹幕'}
                  </button>
                  <button type="button" className={`fullscreen-control${showDanmakuSettings ? ' active' : ''}`} onClick={() => setShowDanmakuSettings(true)}>{translate("\n                    弹幕设置\n                  ")}</button>
                  <button type="button" className={`fullscreen-control${showPlayerSettings ? ' active' : ''}`} onClick={() => setShowPlayerSettings(true)}>{translate("\n                    播放器设置\n                  ")}</button>
                  <button type="button" className="fullscreen-control fullscreen-exit" onClick={() => void toggleFullscreen()} title={translate("退出全屏")} aria-label={translate("退出全屏")}>{translate("\n                    退出全屏\n                  ")}</button>
                </div>
              </div>
            ) : null}
            {isFullscreen && (settings?.fullscreenPlaybackTimeEnabled !== false || settings?.fullscreenSystemTimeEnabled !== false) ? (
              <div className="player-fullscreen-fixed-info">
                {settings?.fullscreenPlaybackTimeEnabled !== false ? (
                  <time className="player-fullscreen-playback-time" aria-label={translate("已播放时长和总时长")}>
                    {formatClock(playbackPosition)} / {playbackDuration > 0 ? formatClock(playbackDuration) : '--:--'}
                  </time>
                ) : null}
                {settings?.fullscreenSystemTimeEnabled !== false ? (
                  <time className="player-fullscreen-clock" dateTime={systemClock.toISOString()}>{fullscreenTime}</time>
                ) : null}
              </div>
            ) : null}
            <div
              className={`player-progress-preview${progressPreview ? ' visible' : ''}${isFullscreen ? ' is-fullscreen' : ''}`}
              style={{ left: `${progressPreview?.x ?? previewLastXRef.current}px` }}
              aria-hidden="true"
            >
              <div className={`player-progress-preview-frame${previewFrameReady ? ' ready' : ''}`}>
                <div ref={progressPreviewContainerRef} className="player-progress-preview-video" />
                {!previewFrameReady && playbackSource ? <span className="player-progress-preview-loading"><span className="spin" /></span> : null}
              </div>
              <time>{progressPreview ? formatClock(progressPreview.seconds) : '--:--'}</time>
            </div>
            {resolving ? (
              <div className="player-stage-note">
                <span className="spin" />{translate("\n                这条线路给的不是直链，正在换播放地址…\n              ")}</div>
            ) : null}
          </div>

          {!resolving && resolveNote ? (
            <div className="player-note">
              <Icon name="info" size={13} />
              {resolveNote}
              {danmakuCandidates.length > 1 ? (
                <div className="danmaku-choice danmaku-choice-inline">
                  <label htmlFor="danmaku-match">{translate("弹幕匹配")}</label>
                  <select
                    id="danmaku-match"
                    className="input"
                    value={selectedDanmaku}
                    onChange={async (event) => {
                      const id = event.target.value
                      const sequence = ++danmakuSequence.current
                      cancelDanmakuBatches()
                      setSelectedDanmaku(id)
                      setDanmakuCues([])
                      setDanmakuMessage(translate('正在加载弹幕…'))
                      try {
                        const cues = await window.api.danmaku.load(id, danmakuRequestId)
                        if (danmakuSequence.current !== sequence) return
                        if (!cues.length) {
                          setDanmakuMessage(translate('该匹配项暂无弹幕'))
                          return
                        }
                        displayDanmakuProgressively(cues, () => danmakuSequence.current === sequence)
                      } catch (err) {
                        if (danmakuSequence.current !== sequence) return
                        setDanmakuMessage((err as Error).message)
                      }
                    }}
                  >
                    {danmakuCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                  </select>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="player-bar">
            <button
              type="button"
              className="btn btn-sm"
              disabled={prev < 0}
              onClick={() => goTo(prev)}
            >
              <Icon name="chevron-left" size={13} />{translate(" 上一集\n            ")}</button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={next < 0}
              onClick={() => goTo(next)}
            >{translate("\n              下一集 ")}<Icon name="chevron-right" size={13} />
            </button>
            <SkipMarkerButton label="片头" seconds={currentSkipMarkers.introSkipSeconds} onMark={() => markSkipPosition('introSkipSeconds')} onClear={() => clearSkipMarker('introSkipSeconds')} />
            <SkipMarkerButton label="片尾" seconds={currentSkipMarkers.outroSkipAtSeconds} onMark={() => markSkipPosition('outroSkipAtSeconds')} onClear={() => clearSkipMarker('outroSkipAtSeconds')} />
            <span className="grow" />
            <button type="button" className="btn btn-sm" disabled={cacheBusy} onClick={() => { setCacheSelection([]); setShowCachePicker(true) }} title={translate("选择剧集加入离线缓存")}>
              {cacheBusy ? <span className="spin" /> : <Icon name="download" size={13} />}{translate(" 缓存\n            ")}</button>
            <button
              type="button"
              className={`btn btn-sm${showDanmaku ? ' btn-primary' : ''}`}
              onClick={toggleDanmaku}
              title={danmakuMessage}
            >
              {showDanmaku ? '隐藏弹幕' : '显示弹幕'}{danmakuCues.length ? ` · ${danmakuCues.length}` : ''}
            </button>
            <button type="button" className={`btn btn-sm${showDanmakuSettings ? ' btn-primary' : ''}`} onClick={() => setShowDanmakuSettings((value) => !value)} aria-expanded={showDanmakuSettings}>{translate("\n              弹幕设置\n            ")}</button>
            <button type="button" className={`btn btn-sm${showPlayerSettings ? ' btn-primary' : ''}`} onClick={() => setShowPlayerSettings(true)} aria-expanded={showPlayerSettings}>{translate("\n              播放器设置\n            ")}</button>
            <span className="danmaku-status" title={danmakuMessage}>{danmakuMessage}</span>
            <button
              type="button"
              className={`btn btn-sm${favorited ? ' btn-primary' : ''}`}
              disabled={favoriteBusy}
              title={translate(favorited ? '已收藏' : '收藏')}
              onClick={() => {
                setFavoriteBusy(true)
                void toggleFavorite(toFavoriteInput(detail))
                  .catch((err: Error) => notify(`收藏操作失败：${err.message}`, 'danger'))
                  .finally(() => setFavoriteBusy(false))
              }}
            >
              <Icon name="star" size={14} />{translate(favorited ? '已收藏' : '收藏')}
            </button>
          </div>

          <section className="player-detail-info" aria-label={translate('影片信息')}>
            <div className="player-detail-heading">
                <h2>{detail.vod_name}</h2>
                <div className="player-detail-meta">
                  {detail.vod_score && Number(detail.vod_score) > 0 ? (
                    <span className="player-detail-score">{Number(detail.vod_score).toFixed(1)}</span>
                  ) : null}
                  {[detail.vod_year, detail.vod_area, detail.type_name, detail.vod_remarks].filter(Boolean).map((value, index) => (
                    <span className="tag tag-outline" key={`${index}-${value}`}>{value}</span>
                  ))}
                </div>
            </div>
            {detail.vod_director ? (
              <div className="player-detail-crew"><span>{translate('导演')}</span>{detail.vod_director}</div>
            ) : null}
            {detail.vod_actor ? (
              <div className="player-detail-crew"><span>{translate('主演')}</span>{detail.vod_actor}</div>
            ) : null}
            {description ? (
              <div className={`player-detail-description${descriptionExpanded ? ' open' : ''}`}>
                {description}
                {description.length > 150 ? (
                  <button type="button" onClick={() => setDescriptionExpanded((value) => !value)}>
                    {translate(descriptionExpanded ? '收起' : '展开')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>

          {showDanmakuSettings && settings ? createPortal(
            <div className="danmaku-settings-backdrop" onMouseDown={(event) => {
              if (event.target === event.currentTarget) setShowDanmakuSettings(false)
            }}>
              <section className="danmaku-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="danmaku-settings-title">
                <header className="danmaku-settings-header">
                  <h2 id="danmaku-settings-title">{translate("弹幕设置")}</h2>
                  <button type="button" className="btn btn-icon" onClick={() => setShowDanmakuSettings(false)} aria-label={translate("关闭弹幕设置")} title={translate("关闭")}>
                    <Icon name="close" size={17} />
                  </button>
                </header>
                <DanmakuSettingsPanel settings={settings} enabled={showDanmaku} onPatch={updateSettings} onToggleDanmaku={toggleDanmaku} />
              </section>
            </div>,
            isFullscreen && stageRef.current ? stageRef.current : document.body
          ) : null}

          {showPlayerSettings && settings ? createPortal(
            <div className="danmaku-settings-backdrop" onMouseDown={(event) => {
              if (event.target === event.currentTarget) setShowPlayerSettings(false)
            }}>
              <section className="danmaku-settings-dialog player-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="player-settings-title">
                <header className="danmaku-settings-header">
                  <h2 id="player-settings-title">{translate("播放器设置")}</h2>
                  <button type="button" className="btn btn-icon" onClick={() => setShowPlayerSettings(false)} aria-label={translate("关闭播放器设置")} title={translate("关闭")}>
                    <Icon name="close" size={17} />
                  </button>
                </header>
                <div className="player-settings-options">
                  <label>
                    <span>{translate("全屏显示系统时间")}</span>
                    <Switch checked={settings.fullscreenSystemTimeEnabled !== false} onChange={(checked) => void updateSettings({ fullscreenSystemTimeEnabled: checked })} />
                  </label>
                  <label>
                    <span>{translate("全屏显示已播放时长 / 总时长")}</span>
                    <Switch checked={settings.fullscreenPlaybackTimeEnabled !== false} onChange={(checked) => void updateSettings({ fullscreenPlaybackTimeEnabled: checked })} />
                  </label>
                </div>
              </section>
            </div>,
            isFullscreen && stageRef.current ? stageRef.current : document.body
          ) : null}

          {showEpisodePicker ? createPortal(
            <div className="danmaku-settings-backdrop episode-picker-backdrop" onMouseDown={(event) => {
              if (event.target === event.currentTarget) setShowEpisodePicker(false)
            }}>
              <section className="danmaku-settings-dialog episode-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="episode-picker-title">
                <header className="danmaku-settings-header">
                  <h2 id="episode-picker-title">{translate("选择剧集")}</h2>
                  <button type="button" className="btn btn-icon" onClick={() => setShowEpisodePicker(false)} aria-label={translate("关闭选集弹窗")} title={translate("关闭")}>
                    <Icon name="close" size={17} />
                  </button>
                </header>
                <div className="episode-picker-grid">
                  {episodes.map((item, index) => (
                    <button key={`${item.index}-${item.url}`} type="button" className={index === epIndex ? 'active' : ''} onClick={() => goTo(index)} title={item.name}>
                      {item.name}
                    </button>
                  ))}
                </div>
              </section>
            </div>,
            isFullscreen && stageRef.current ? stageRef.current : document.body
          ) : null}

          {showCachePicker ? createPortal(
            <div className="danmaku-settings-backdrop" onMouseDown={(event) => {
              if (event.target === event.currentTarget && !cacheBusy) setShowCachePicker(false)
            }}>
              <section className="danmaku-settings-dialog episode-picker-dialog cache-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="cache-picker-title">
                <header className="danmaku-settings-header">
                  <h2 id="cache-picker-title">{translate("选择缓存剧集")}</h2>
                  <div className="cache-picker-header-actions">
                    <button type="button" className="btn btn-sm" onClick={() => setCacheSelection(episodes.map((_, index) => index))}>{translate("全选")}</button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCacheSelection([])}>{translate("清空")}</button>
                    <button type="button" className="btn btn-icon" onClick={() => setShowCachePicker(false)} aria-label={translate("关闭缓存选集")} title={translate("关闭")} disabled={cacheBusy}>
                      <Icon name="close" size={17} />
                    </button>
                  </div>
                </header>
                <div className="episode-picker-grid cache-picker-grid">
                  {episodes.map((item, index) => {
                    const selected = cacheSelection.includes(index)
                    return (
                      <button key={`${item.index}-${item.url}`} type="button" className={selected ? 'active' : ''} aria-pressed={selected}
                        onClick={() => setCacheSelection((current) => selected ? current.filter((value) => value !== index) : [...current, index])} title={item.name}>
                        {item.name}
                      </button>
                    )
                  })}
                </div>
                <footer className="cache-picker-footer">
                  <span>{translate("已选 ")}{cacheSelection.length} / {episodes.length}{translate(" 集")}</span>
                  <button type="button" className="btn btn-sm btn-primary" disabled={!cacheSelection.length || cacheBusy} onClick={() => void cacheSelectedEpisodes()}>
                    {cacheBusy ? <span className="spin" /> : <Icon name="download" size={13} />}{translate(" 开始缓存\n                  ")}</button>
                </footer>
              </section>
            </div>,
            isFullscreen && stageRef.current ? stageRef.current : document.body
          ) : null}

          {error ? <div className="banner banner-danger">{error}</div> : null}

          {!direct && betterLine >= 0 ? (
            <div className="banner banner-info">{translate("\n              这条线路放不出来时，可以试试\n              ")}<Link
                to={`/play/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}/${betterLine}/0`}
              state={playerRouteState}
              >
                「{detail.lines[betterLine].name}」
              </Link>
            </div>
          ) : null}

          {hint ? <div className="banner banner-info">{hint}</div> : null}

          {/* key 带上集号：换集时直接重建组件，总结结果不会串到下一集 */}
          <AiSummary
            key={`${siteKey}/${vodId}/${lineIndex}/${epIndex}`}
            hasKey={(settings?.ai?.apiKey ?? '').trim().length > 0}
            getVideo={() => playerRef.current?.el().querySelector('video') ?? null}
            input={{
              vodName: detail.vod_name,
              typeName: detail.type_name,
              year: detail.vod_year,
              area: detail.vod_area,
              actor: detail.vod_actor,
              director: detail.vod_director,
              score: detail.vod_score,
              remarks: detail.vod_remarks,
              content: detail.vod_content,
              epName: episode.name,
              epIndex,
              epTotal: episodes.length,
              lineName: line?.name
            }}
          />
        </div>

        <aside className="player-side">
          <div className="player-side-head">
            <Poster src={detail.vod_pic} name={detail.vod_name} className="poster-side" />
            <div>
              <div className="player-side-title">{detail.vod_name}</div>
              <div className="text-3 fs-12">{line?.name}</div>
              <div className="text-3 fs-12">{translate("\n                第 ")}{epIndex + 1} / {episodes.length}{translate(" 集\n              ")}</div>
            </div>
          </div>

          {detail.lines.length > 1 ? (
            <div className="player-lines">
              <div className="player-side-label">{translate("线路")}</div>
              <div className="source-chips">
                {detail.lines.map((item, index) => (
                  <button
                    key={`${item.name}-${index}`}
                    type="button"
                    className={`chip chip-source${index === lineIndex ? ' active' : ''}`}
                    title={`${item.name} · ${item.episodes.length} 集`}
                    onClick={() => navigateToLine(index)}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="player-sources">
            <div className="player-side-label">
              <span>{translate("片源")}</span>
              {sources.length > 1 ? (
                <span className="text-3 fs-12">{sources.length}{translate(" 个")}</span>
              ) : null}
            </div>
            {sources.length > 1 ? (
              <div className="source-chips">
                {sources.map((v) => {
                  const active = v.siteKey === siteKey && v.vod_id === vodId
                  const title = v.vod_name && v.vod_name !== detail.vod_name
                    ? `${v.siteName}（该源片名：${v.vod_name}）`
                    : v.siteName
                  return active ? (
                    <span
                      key={`${v.siteKey}/${v.vod_id}`}
                      className="chip chip-source active"
                      title={`${title} · 正在看`}
                    >
                      {v.siteName}
                    </span>
                  ) : (
                    <Link
                      key={`${v.siteKey}/${v.vod_id}`}
                      className="chip chip-source"
                      title={`${title} · 点一下换到这个源`}
                      to={`/play/${encodeURIComponent(v.siteKey)}/${encodeURIComponent(v.vod_id)}/0/0`}
                      state={playerRouteState}
                    >
                      {v.siteName}
                    </Link>
                  )
                })}
              </div>
            ) : (
              <div className="player-sources-empty">
                <span className="text-3 fs-12">{translate("只找到这一个片源")}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={finding}
                  onClick={() => void findSources()}
                >
                  {finding ? <span className="spin" /> : <Icon name="search" size={13} />}{translate(" 找其它片源\n                ")}</button>
              </div>
            )}
          </div>

          <div className="player-episodes">
            {episodes.map((ep) => (
              <button
                key={`${ep.index}-${ep.url}`}
                type="button"
                className={`episode episode-sm ${ep.index === epIndex ? 'active' : ''}`}
                onClick={() => goTo(ep.index)}
                title={ep.name}
              >
                {ep.name}
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}

interface SkipMarkerButtonProps {
  label: '片头' | '片尾'
  seconds: number
  className?: string
  onMark: () => void
  onClear: () => void
}

function SkipMarkerButton({ label, seconds, className = 'btn btn-sm', onMark, onClear }: SkipMarkerButtonProps): JSX.Element {
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = useRef(false)
  const clearTimer = (): void => {
    if (holdTimer.current === null) return
    clearTimeout(holdTimer.current)
    holdTimer.current = null
  }
  useEffect(() => () => clearTimer(), [])
  const startHold = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    longPressed.current = false
    clearTimer()
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null
      longPressed.current = true
      onClear()
    }, SKIP_MARKER_LONG_PRESS_MS)
  }
  const markerText = seconds > 0 ? `${label} ${formatMarkerTime(seconds)}` : label

  return (
    <button
      type="button"
      className={`${className} skip-marker-button`}
      title={translate("单击标记当前位置，长按清除")}
      aria-label={`${markerText}，单击标记当前位置，长按清除`}
      onPointerDown={startHold}
      onPointerUp={clearTimer}
      onPointerLeave={() => {
        clearTimer()
        longPressed.current = false
      }}
      onPointerCancel={() => {
        clearTimer()
        longPressed.current = false
      }}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false
          return
        }
        onMark()
      }}
    >
      {markerText}
    </button>
  )
}
