import 'video.js/dist/video-js.css'
import '@videojs/themes/dist/city/index.css'
import './styles/tokens.css'
import './styles/global.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { initializeDesktopRuntime } from '../../preload/index'
import App from './App'

void initializeDesktopRuntime().then(async () => {
  const appWindow = getCurrentWindow()
  let resizeTimer = 0
  await appWindow.onResized(({ payload }) => {
    void Promise.all([appWindow.scaleFactor(), appWindow.isMaximized(), appWindow.isMinimized()])
      .then(([scale, maximized, minimized]) => {
        if (maximized || minimized) return
        window.clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(() => {
          void window.api.settings.set({
            window: {
              width: Math.round(payload.width / scale),
              height: Math.round(payload.height / scale)
            }
          }).catch((error: unknown) => console.error('[tauri] 保存窗口尺寸失败', error))
        }, 400)
      })
      .catch((error: unknown) => console.error('[tauri] 读取窗口状态失败', error))
  })
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>
  )
})
