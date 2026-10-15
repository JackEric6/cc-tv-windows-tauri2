import videojs from 'video.js'
import { isHls } from '@/utils/media'

export type VideoPlayer = ReturnType<typeof videojs>

export interface VideoOptions {
  url: string
  accent?: string
  poster?: string
  hls?: boolean
  toggleFullscreen?: () => void
  onControlError?: (message: string) => void
  preview?: boolean
}

export function createVideoPlayer(container: HTMLDivElement, options: VideoOptions): VideoPlayer {
  const video = document.createElement('video')
  video.className = 'video-js vjs-theme-city vjs-big-play-centered'
  video.setAttribute('playsinline', 'true')
  video.setAttribute('crossorigin', 'anonymous')
  container.replaceChildren(video)
  container.style.setProperty('--video-accent', options.accent ?? '#2563EB')
  container.style.setProperty('--vjs-theme-city--primary', options.accent ?? '#2563EB')

  const player = videojs(video, {
    controls: !options.preview,
    autoplay: !options.preview,
    muted: Boolean(options.preview),
    preload: 'auto',
    responsive: true,
    fluid: false,
    userActions: { doubleClick: false },
    playbackRates: [0.75, 1, 1.25, 1.5, 2, 3],
    poster: options.poster,
    controlBar: options.preview ? false : {
      currentTimeDisplay: true,
      timeDivider: true,
      durationDisplay: true,
      remainingTimeDisplay: false,
      pictureInPictureToggle: true,
      playbackRateMenuButton: true,
      volumePanel: { inline: false }
    },
    inactivityTimeout: 0,
    html5: { vhs: { overrideNative: true, enableLowInitialPlaylist: false } } as any
  })
  const volumeControl = (player.getChild('controlBar') as any)?.getChild('volumePanel')?.getChild('volumeControl')
  const updateVolumeLabel = (): void => {
    const element = volumeControl?.el() as HTMLElement | undefined
    if (element) element.dataset.volume = String(Math.round((player.volume() ?? 1) * 100))
  }
  player.on('volumechange', updateVolumeLabel)
  player.ready(updateVolumeLabel)
  if (!options.preview) {
    player.ready(() => {
      const controlBar = player.getChild('controlBar') as any
      const bindClick = (name: string, action: () => void | Promise<void>): void => {
        const element = controlBar?.getChild(name)?.el() as HTMLElement | undefined
        if (!element) return
        const onClick = (event: MouseEvent): void => {
          event.preventDefault()
          event.stopImmediatePropagation()
          const reportError = (error: unknown): void => {
            const message = error instanceof Error ? error.message : String(error)
            options.onControlError?.(message)
            if (!options.onControlError) console.error('[player] 控件操作失败', error)
          }
          try {
            void Promise.resolve(action()).catch(reportError)
          } catch (error) {
            reportError(error)
          }
        }
        element.addEventListener('click', onClick, true)
        player.one('dispose', () => element.removeEventListener('click', onClick, true))
      }

      bindClick('playToggle', async () => {
        if (player.paused()) await Promise.resolve(player.play())
        else player.pause()
      })
      bindClick('muteToggle', () => { player.muted(!player.muted()) })
      bindClick('pictureInPictureToggle', async () => {
        const media = player.el().querySelector('video')
        if (!media) throw new Error('没有可用的视频画面')
        if (document.pictureInPictureElement === media) {
          await document.exitPictureInPicture()
          return
        }
        if (!document.pictureInPictureEnabled || typeof media.requestPictureInPicture !== 'function') {
          throw new Error('当前 WebView2 不支持画中画')
        }
        await media.requestPictureInPicture()
      })
    })
  }
  if (options.toggleFullscreen) {
    const fullscreenButton = (player.getChild('controlBar') as any)?.getChild('fullscreenToggle')
    const buttonElement = fullscreenButton?.el() as HTMLElement | undefined
    if (buttonElement) {
      const icon = document.createElement('span')
      icon.className = 'player-fullscreen-mark'
      icon.setAttribute('aria-hidden', 'true')
      buttonElement.querySelector('.vjs-icon-placeholder')?.replaceChildren(icon)

      const updateIcon = (): void => {
        icon.classList.toggle('is-exit', Boolean(document.fullscreenElement?.contains(player.el())))
      }
      updateIcon()
      document.addEventListener('fullscreenchange', updateIcon)

      const onClick = (event: MouseEvent): void => {
        event.preventDefault()
        event.stopImmediatePropagation()
        options.toggleFullscreen?.()
      }
      buttonElement.addEventListener('click', onClick, true)
      player.one('dispose', () => {
        buttonElement.removeEventListener('click', onClick, true)
        document.removeEventListener('fullscreenchange', updateIcon)
      })
    }
  }
  player.src({
    src: options.url,
    ...(isHls(options.url) || options.hls ? { type: 'application/x-mpegURL' }
      : /\.mpd(?:$|[?#])/i.test(options.url) ? { type: 'application/dash+xml' } : {})
  })
  return player
}
