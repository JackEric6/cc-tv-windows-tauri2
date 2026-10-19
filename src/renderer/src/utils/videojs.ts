import videojs from 'video.js'
import { isHls } from '@/utils/media'

export type VideoPlayer = ReturnType<typeof videojs>

export interface VideoOptions {
  url: string
  accent?: string
  poster?: string
  hls?: boolean
  autoplay?: boolean
  bigPlayButton?: boolean
  toggleFullscreen?: () => void
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
    autoplay: options.autoplay ?? !options.preview,
    bigPlayButton: options.bigPlayButton ?? !options.preview,
    muted: Boolean(options.preview),
    preload: options.preview ? 'metadata' : 'auto',
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
    html5: {
      vhs: {
        overrideNative: true,
        enableLowInitialPlaylist: true,
        useBandwidthFromLocalStorage: !options.preview,
        ...(options.preview ? { bandwidth: 600_000 } : {})
      }
    } as any
  })
  const volumeControl = (player.getChild('controlBar') as any)?.getChild('volumePanel')?.getChild('volumeControl')
  const updateVolumeLabel = (): void => {
    const element = volumeControl?.el() as HTMLElement | undefined
    if (element) element.dataset.volume = String(Math.round((player.volume() ?? 1) * 100))
  }
  player.on('volumechange', updateVolumeLabel)
  player.ready(updateVolumeLabel)
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
  const controlBar = (player.getChild('controlBar') as any)?.el() as HTMLElement | undefined
  if (controlBar) {
    const pictureInPictureButton = controlBar.querySelector<HTMLElement>('.vjs-picture-in-picture-control')
    const fullscreenButton = controlBar.querySelector<HTMLElement>('.vjs-fullscreen-control')
    if (fullscreenButton) {
      const alignRightControls = (): void => {
        const pictureInPictureVisible = Boolean(pictureInPictureButton &&
          pictureInPictureButton.offsetParent !== null &&
          getComputedStyle(pictureInPictureButton).display !== 'none')
        const fullscreenMargin = pictureInPictureVisible ? '' : 'auto'
        if (fullscreenButton.style.marginLeft !== fullscreenMargin) {
          fullscreenButton.style.marginLeft = fullscreenMargin
        }
        if (pictureInPictureButton) {
          const pictureInPictureMargin = pictureInPictureVisible ? 'auto' : ''
          if (pictureInPictureButton.style.marginLeft !== pictureInPictureMargin) {
            pictureInPictureButton.style.marginLeft = pictureInPictureMargin
          }
        }
      }
      alignRightControls()
      const observer = new MutationObserver(alignRightControls)
      observer.observe(controlBar, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'style'] })
      player.ready(alignRightControls)
      player.one('dispose', () => observer.disconnect())
    }
  }
  player.src({
    src: options.url,
    ...(isHls(options.url) || options.hls ? { type: 'application/x-mpegURL' }
      : /\.mpd(?:$|[?#])/i.test(options.url) ? { type: 'application/dash+xml' } : {})
  })
  return player
}

/** 拖动 seek 时优先落到邻近关键帧，WebView2 不支持时回退到精确 currentTime。 */
export function seekVideoPlayer(player: VideoPlayer, seconds: number): void {
  const element = player.tech(true)?.el() as HTMLMediaElement | undefined
  if (element && typeof element.fastSeek === 'function' && element.readyState >= 1) {
    try {
      element.fastSeek(seconds)
      return
    } catch {
      // Metadata or seekable ranges may not be ready yet.
    }
  }
  player.currentTime(seconds)
}
