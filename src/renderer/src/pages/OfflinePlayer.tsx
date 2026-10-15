import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { DanmakuCue, OfflineTask } from '@shared/types'
import { DanmakuCanvas } from '@/components/DanmakuCanvas'
import { Icon } from '@/components/icons'
import { useApp } from '@/store/useApp'
import { formatClock } from '@/utils/format'
import { createVideoPlayer, type VideoPlayer } from '@/utils/videojs'
import { translate } from '@/i18n'

const FULLSCREEN_CONTROL_HOVER_HEIGHT = 112
const FULLSCREEN_PAUSE_PEEK_MS = 1000
const FULLSCREEN_PLAY_IDLE_MS = 3200

export function OfflinePlayer(): JSX.Element {
  const { id = '' } = useParams()
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const pointerInsidePlayer = useRef(false)
  const playerRef = useRef<VideoPlayer | null>(null)
  const hideTimer = useRef<number | undefined>(undefined)
  const settings = useApp((state) => state.settings)
  const recordHistory = useApp((state) => state.recordHistory)
  const notify = useApp((state) => state.notify)
  const [task, setTask] = useState<OfflineTask | null>(null)
  const [error, setError] = useState('')
  const [cues, setCues] = useState<DanmakuCue[]>([])
  const [player, setPlayer] = useState<VideoPlayer | null>(null)
  const [danmakuVisible, setDanmakuVisible] = useState(settings?.danmakuEnabled !== false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [systemClock, setSystemClock] = useState(() => new Date())

  const clearHideTimer = useCallback((): void => {
    if (hideTimer.current === undefined) return
    window.clearTimeout(hideTimer.current)
    hideTimer.current = undefined
  }, [])

  const scheduleHide = useCallback((delay: number): void => {
    clearHideTimer()
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = undefined
      setControlsVisible(false)
    }, delay)
  }, [clearHideTimer])

  const toggleFullscreen = useCallback(async (): Promise<void> => {
    const stage = stageRef.current
    if (!stage) return
    try {
      if (document.fullscreenElement === stage) await document.exitFullscreen()
      else await stage.requestFullscreen()
    } catch {
      setError(translate('当前窗口无法切换全屏。'))
    }
  }, [])

  useEffect(() => {
    let alive = true
    const container = containerRef.current
    if (!container) return

    void (async () => {
      try {
        const playback = await window.api.offline.play(id)
        if (!alive) return
        const item = playback.task
        setTask(item)
        setCues(playback.danmaku)

        const snapshot = await window.api.library.get().catch(() => null)
        const resume = snapshot?.history.flatMap((group) => group.items).find((entry) =>
          entry.siteKey === item.siteKey && entry.vodId === item.vodId &&
          entry.lineIndex === (item.lineIndex ?? 0) && entry.epIndex === item.episodeIndex
        )
        if (!alive) return

        const mounted = createVideoPlayer(container, {
          url: playback.url,
          accent: settings?.accent,
          poster: playback.posterUrl,
          hls: item.mediaFile.toLowerCase().endsWith('.m3u8'),
          toggleFullscreen: () => { void toggleFullscreen() },
          onControlError: (message) => notify(`播放器控制失败：${message}`, 'danger')
        })
        playerRef.current = mounted
        setPlayer(mounted)
        mounted.on('error', () => setError(translate('本地文件无法解码，可能缓存不完整或当前格式不受支持。')))

        let lastSaved = 0
        const save = (force = false): void => {
          const current = playerRef.current
          if (!current) return
          const now = Date.now()
          if (!force && now - lastSaved < 5000) return
          lastSaved = now
          const currentPosition = Math.floor(current.currentTime() || 0)
          const currentDuration = Number.isFinite(current.duration()) ? Math.floor(current.duration() || 0) : 0
          void recordHistory({
            siteKey: item.siteKey,
            siteName: item.siteName,
            vodId: item.vodId,
            name: item.movieName,
            pic: item.pic,
            lineIndex: item.lineIndex ?? 0,
            epIndex: item.episodeIndex,
            epName: item.episodeName,
            offlineTaskId: item.id,
            position: currentPosition,
            duration: currentDuration
          })
        }

        mounted.on('loadedmetadata', () => {
          const videoDuration = mounted.duration()
          const validDuration = typeof videoDuration === 'number' && Number.isFinite(videoDuration) ? videoDuration : 0
          setDuration(validDuration)
          const resumePosition = resume?.position ?? 0
          if (resumePosition > 1 && validDuration > 1) {
            const target = Math.min(resumePosition, validDuration - 0.5)
            mounted.currentTime(target)
            setPosition(target)
          }
          save(true)
        })
        mounted.on('timeupdate', () => {
          const currentPosition = mounted.currentTime()
          const videoDuration = mounted.duration()
          setPosition(typeof currentPosition === 'number' && Number.isFinite(currentPosition) ? currentPosition : 0)
          setDuration(typeof videoDuration === 'number' && Number.isFinite(videoDuration) ? videoDuration : 0)
          save()
        })
        mounted.on('pause', () => {
          setIsPlaying(false)
          save(true)
          if (document.fullscreenElement === stageRef.current) {
            setControlsVisible(true)
            scheduleHide(FULLSCREEN_PAUSE_PEEK_MS)
          }
        })
        mounted.on('play', () => {
          setIsPlaying(true)
          if (document.fullscreenElement === stageRef.current) scheduleHide(FULLSCREEN_PLAY_IDLE_MS)
        })
        mounted.on('playing', () => setIsPlaying(true))
        mounted.on('ended', () => save(true))
        mounted.on('dispose', () => save(true))
      } catch (reason) {
        if (alive) setError((reason as Error).message)
      }
    })()

    return () => {
      alive = false
      clearHideTimer()
      playerRef.current?.dispose()
      playerRef.current = null
      setPlayer(null)
    }
  }, [id, settings?.accent, toggleFullscreen, recordHistory, scheduleHide, clearHideTimer])

  useEffect(() => {
    setDanmakuVisible(settings?.danmakuEnabled !== false)
  }, [settings?.danmakuEnabled])

  useEffect(() => {
    const onFullscreenChange = (): void => {
      const active = document.fullscreenElement === stageRef.current
      clearHideTimer()
      setIsFullscreen(active)
      setControlsVisible(true)
      if (active && playerRef.current?.paused()) scheduleHide(FULLSCREEN_PAUSE_PEEK_MS)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [clearHideTimer, scheduleHide])

  useEffect(() => {
    const timer = window.setInterval(() => setSystemClock(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!isFullscreen) {
      clearHideTimer()
      setControlsVisible(true)
      return
    }
    const bounds = stageRef.current?.getBoundingClientRect()
    if (bounds && event.clientY >= bounds.bottom - FULLSCREEN_CONTROL_HOVER_HEIGHT) {
      setControlsVisible(true)
      if (playerRef.current?.paused()) scheduleHide(FULLSCREEN_PAUSE_PEEK_MS)
      else clearHideTimer()
    } else {
      clearHideTimer()
      setControlsVisible(false)
    }
  }

  const togglePlayback = useCallback((): void => {
    const current = playerRef.current
    if (!current) return
    if (current.paused()) void current.play()
    else current.pause()
  }, [])

  useEffect(() => {
    const isTextInput = (target: EventTarget | null): boolean => target instanceof HTMLElement &&
      (target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"]')))
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!pointerInsidePlayer.current || event.altKey || event.ctrlKey || event.metaKey) return
      if (isTextInput(event.target) || isTextInput(document.activeElement)) return
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
  }, [toggleFullscreen, togglePlayback])

  const progress = duration > 0 ? Math.min(100, position * 100 / duration) : 0
  const clock = systemClock.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

  return (
    <div className="page page-offline-player">
      <div className="detail-head">
        <Link className="btn btn-sm" to="/downloads"><Icon name="chevron-left" size={14} />{translate(" 缓存列表")}</Link>
        <span className="detail-title-inline">{task?.movieName ?? translate('离线播放')}</span>
        {task ? <span className="text-3 fs-12">{task.episodeName}</span> : null}
      </div>
      <div
        className={`player-main offline-player-main${controlsVisible ? '' : ' controls-hidden'}`}
        onPointerEnter={() => {
          pointerInsidePlayer.current = true
          setControlsVisible(true)
        }}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          pointerInsidePlayer.current = false
          clearHideTimer()
          setControlsVisible(false)
        }}
      >
        <div
          ref={stageRef}
          className={`player-stage offline-player-stage${isFullscreen ? ' is-fullscreen' : ''}`}
          tabIndex={0}
          onDoubleClick={(event) => {
            const target = event.target as HTMLElement
            if (target.closest('button, input, .vjs-control')) return
            void toggleFullscreen()
          }}
        >
          <div ref={containerRef} className="player-stage-inner offline-player-inner" />
          <DanmakuCanvas
            player={player}
            cues={cues}
            visible={danmakuVisible}
            maxLines={settings?.danmakuMaxLines ?? 3}
            speed={settings?.danmakuSpeed ?? 1}
            size={settings?.danmakuSize ?? 1.2}
            opacity={settings?.danmakuOpacity ?? 0.9}
            randomColor={settings?.danmakuRandomColor ?? true}
          />
          {isFullscreen ? (
            <div className={`player-fullscreen-controls${controlsVisible ? ' visible' : ''}`}>
              <div className="player-fullscreen-bar">
                <input
                  className="player-fullscreen-mini-progress"
                  type="range"
                  min={0}
                  max={Math.max(1, duration)}
                  step={1}
                  value={Math.min(position, duration || 0)}
                  disabled={duration <= 0}
                  style={{ '--progress': `${progress}%` } as CSSProperties}
                  aria-label={translate("跳转播放进度")}
                  onChange={(event) => {
                    const next = Number(event.currentTarget.value)
                    if (!playerRef.current || !Number.isFinite(next)) return
                    playerRef.current.currentTime(next)
                    setPosition(next)
                  }}
                />
                <button type="button" className="fullscreen-control fullscreen-icon-control" onClick={togglePlayback} title={translate(isPlaying ? '暂停' : '播放')} aria-label={translate(isPlaying ? '暂停' : '播放')}>
                  <Icon name={isPlaying ? 'pause' : 'play'} size={16} />
                </button>
                <time className="fullscreen-control fullscreen-playback-time">
                  {formatClock(position)} / {duration > 0 ? formatClock(duration) : '--:--'}
                </time>
                <button type="button" className="fullscreen-control" onClick={() => setDanmakuVisible((value) => !value)}>
                  {translate(danmakuVisible ? '关闭弹幕' : '开启弹幕')}{task?.danmakuCount ? ` · ${task.danmakuCount}` : ''}
                </button>
                <button type="button" className="fullscreen-control fullscreen-exit" onClick={() => void toggleFullscreen()} title={translate("退出全屏")} aria-label={translate("退出全屏")}>{translate("\n                  退出全屏\n                ")}</button>
              </div>
            </div>
          ) : null}
          {isFullscreen && (settings?.fullscreenPlaybackTimeEnabled !== false || settings?.fullscreenSystemTimeEnabled !== false) ? (
            <div className="player-fullscreen-fixed-info">
              {settings?.fullscreenPlaybackTimeEnabled !== false ? (
                <time className="player-fullscreen-playback-time">{formatClock(position)} / {duration > 0 ? formatClock(duration) : '--:--'}</time>
              ) : null}
              {settings?.fullscreenSystemTimeEnabled !== false ? <time className="player-fullscreen-clock">{clock}</time> : null}
            </div>
          ) : null}
        </div>
      </div>
      {error ? <div className="banner banner-danger">{error}</div> : null}
      <div className="player-bar offline-player-bar">
        <button type="button" className={`btn btn-sm${danmakuVisible ? ' btn-primary' : ''}`} onClick={() => setDanmakuVisible((value) => !value)}>
          {translate(danmakuVisible ? '隐藏弹幕' : '显示弹幕')}{cues.length ? ` · ${cues.length}` : ''}
        </button>
        <span className="text-3 fs-12">{translate(task?.posterFile ? '海报已缓存' : '本集离线文件')}{task?.danmakuCount ? ` · ${task.danmakuCount}${translate('条弹幕已缓存')}` : ''}</span>
      </div>
    </div>
  )
}
