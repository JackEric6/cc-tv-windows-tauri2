import { useEffect, useRef } from 'react'
import type { DanmakuCue } from '@shared/types'
import type { VideoPlayer } from '@/utils/videojs'

interface Props {
  player: VideoPlayer | null
  cues: DanmakuCue[]
  visible: boolean
  maxLines: number
  speed: number
  size: number
  opacity: number
  randomColor: boolean
}

const COLORS = ['#ffffff', '#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#c77dff']

interface ScheduledCue {
  cue: DanmakuCue
  time: number
  width: number
  duration: number
  row: number
  fixed: 'top' | 'bottom' | null
}

interface Lane {
  last?: ScheduledCue
}

function stableColor(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0
  return COLORS[Math.abs(hash) % COLORS.length]
}

export function DanmakuCanvas({ player, cues, visible, maxLines, speed, size, opacity, randomColor }: Props): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cuesRef = useRef(cues)
  const syncScheduleRef = useRef<(() => void) | null>(null)
  cuesRef.current = cues

  useEffect(() => {
    syncScheduleRef.current?.()
  }, [cues])

  useEffect(() => {
    const canvas = canvasRef.current
    const video = player?.el().querySelector('video')
    const context = canvas?.getContext('2d')
    if (!canvas || !video || !context || !visible) return

    const fontSize = Math.max(12, 22 * size)
    const lineHeight = fontSize * 1.55
    const duration = Math.max(4, Math.min(20, 10 / Math.max(0.25, speed)))
    let width = 0
    let height = 0
    let scheduled: ScheduledCue[] = []
    let processedCueCount = 0
    let sourceId = ''
    let lastScheduledTime = Number.NEGATIVE_INFINITY
    let rollingLanes: Lane[] = []
    let fixedTopLanes: Lane[] = []
    let fixedBottomLanes: Lane[] = []

    const resetSchedule = (): void => {
      const rect = canvas.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      width = Math.max(0, rect.width)
      height = Math.max(0, rect.height)
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      context.setTransform(scale, 0, 0, scale, 0, 0)

      const requestedRows = Math.max(1, Math.min(12, Math.floor(maxLines)))
      const availableRows = Math.floor(Math.max(0, height - fontSize - lineHeight * 2 - 8) / lineHeight)
      const rowCount = Math.max(1, Math.min(requestedRows, availableRows || 1))
      rollingLanes = Array.from({ length: rowCount }, () => ({}))
      fixedTopLanes = [{}]
      fixedBottomLanes = [{}]
      context.font = `600 ${fontSize}px Arial, sans-serif`
      scheduled = []
      processedCueCount = 0
      sourceId = ''
      lastScheduledTime = Number.NEGATIVE_INFINITY
    }

    const availableAt = (lane: Lane, item: ScheduledCue): number => {
      const previous = lane.last
      if (!previous) return Number.NEGATIVE_INFINITY
      if (previous.fixed || item.fixed) return previous.time + previous.duration + 0.24
      const previousExit = previous.width * previous.duration / (width + previous.width)
      const currentExit = item.width * item.duration / (width + item.width)
      return previous.time + Math.max(previousExit, currentExit) + 0.24
    }

    const appendSchedule = (startAt: number): void => {
      if (!width || !height) return
      const currentCues = cuesRef.current
      const ordered = currentCues.slice(startAt)
        .filter((cue) => Number.isFinite(cue.time) && cue.text.trim().length > 0)
        .map((cue) => {
          const measured = context.measureText(cue.text).width
          return {
            cue,
            time: cue.time,
            width: Math.min(measured, Math.max(1, width - 24)),
            duration,
            row: -1,
            fixed: cue.type === 4 ? 'bottom' as const : cue.type === 5 ? 'top' as const : null
          }
        })
        .sort((a, b) => a.time - b.time)

      if (ordered.length && ordered[0].time < lastScheduledTime) {
        resetSchedule()
        appendSchedule(0)
        return
      }
      for (const item of ordered) {
        const lanes = item.fixed === 'bottom'
          ? fixedBottomLanes
          : item.fixed === 'top'
            ? fixedTopLanes
            : rollingLanes
        const row = lanes.findIndex((lane) => availableAt(lane, item) <= item.time)
        if (row < 0) continue
        item.row = row
        lanes[row].last = item
        scheduled.push(item)
        lastScheduledTime = item.time
      }
      processedCueCount = currentCues.length
      sourceId = currentCues[0]?.id ?? ''
    }

    const syncSchedule = (): void => {
      const currentCues = cuesRef.current
      const nextSourceId = currentCues[0]?.id ?? ''
      if (currentCues.length < processedCueCount || (sourceId && nextSourceId !== sourceId)) {
        resetSchedule()
        appendSchedule(0)
      } else if (currentCues.length > processedCueCount) {
        appendSchedule(processedCueCount)
      }
      draw()
    }

    const buildSchedule = (): void => {
      resetSchedule()
      appendSchedule(0)
    }

    let frame = 0
    const draw = (): void => {
      context.clearRect(0, 0, width, height)
      context.globalAlpha = Math.max(0.1, Math.min(1, opacity))
      const current = video.currentTime || 0
      let low = 0
      let high = scheduled.length
      while (low < high) {
        const mid = (low + high) >>> 1
        if (scheduled[mid].time <= current) low = mid + 1
        else high = mid
      }
      const active: ScheduledCue[] = []
      for (let i = low - 1; i >= 0 && active.length < 60; i--) {
        if (current - scheduled[i].time > scheduled[i].duration) break
        active.push(scheduled[i])
      }
      for (const item of active.reverse()) {
        const elapsed = current - item.time
        if (elapsed < 0 || elapsed > item.duration) continue
        const cue = item.cue
        const x = item.fixed
          ? Math.max(8, (width - item.width) / 2)
          : width - (elapsed / item.duration) * (width + item.width)
        const y = item.fixed === 'bottom'
          ? height - 8 - item.row * lineHeight
          : item.fixed === 'top'
            ? fontSize
            : fontSize + (item.row + 1) * lineHeight
        context.lineWidth = 3
        context.lineJoin = 'round'
        context.strokeStyle = 'rgba(0,0,0,.86)'
        context.fillStyle = randomColor ? stableColor(cue.id || cue.text) : cue.color
        context.strokeText(cue.text, x, y, item.width)
        context.fillText(cue.text, x, y, item.width)
      }
      context.globalAlpha = 1
    }
    syncScheduleRef.current = syncSchedule
    buildSchedule()
    const tick = (): void => {
      if (video.seeking) {
        frame = 0
        return
      }
      draw()
      frame = video.paused ? 0 : requestAnimationFrame(tick)
    }
    const start = (): void => {
      if (!frame && !video.seeking) frame = requestAnimationFrame(tick)
    }
    const stop = (): void => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      draw()
    }
    const resize = (): void => {
      buildSchedule()
      if (video.paused) draw()
    }
    const updatePausedFrame = (): void => {
      if (video.paused && !video.seeking) draw()
    }
    const pauseForSeek = (): void => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    }
    const resumeAfterSeek = (): void => {
      draw()
      if (!video.paused) start()
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)
    video.addEventListener('play', start)
    video.addEventListener('playing', start)
    video.addEventListener('pause', stop)
    video.addEventListener('seeking', pauseForSeek)
    video.addEventListener('seeked', resumeAfterSeek)
    video.addEventListener('timeupdate', updatePausedFrame)
    if (video.paused) draw()
    else start()
    return () => {
      if (syncScheduleRef.current === syncSchedule) syncScheduleRef.current = null
      if (frame) cancelAnimationFrame(frame)
      video.removeEventListener('play', start)
      video.removeEventListener('playing', start)
      video.removeEventListener('pause', stop)
      video.removeEventListener('seeking', pauseForSeek)
      video.removeEventListener('seeked', resumeAfterSeek)
      video.removeEventListener('timeupdate', updatePausedFrame)
      resizeObserver.disconnect()
      context.clearRect(0, 0, width, height)
    }
  }, [player, visible, maxLines, speed, size, opacity, randomColor])

  return <canvas ref={canvasRef} className="danmaku-canvas" aria-hidden="true" />
}
