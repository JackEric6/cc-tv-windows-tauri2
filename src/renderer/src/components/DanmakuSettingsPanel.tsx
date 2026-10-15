import type { AppSettings } from '@shared/types'
import { Switch } from '@/components/Switch'
import { translate } from '@/i18n'

interface Props {
  settings: AppSettings | null
  enabled: boolean
  onPatch: (patch: Partial<AppSettings>) => Promise<void>
  onToggleDanmaku: () => void
}

export function DanmakuSettingsPanel({ settings, enabled, onPatch, onToggleDanmaku }: Props): JSX.Element | null {
  if (!settings) return null

  return (
    <div className="danmaku-settings-panel">
      <div className="danmaku-setting danmaku-color-setting">
        <span>{translate("弹幕")}</span>
        <Switch checked={enabled} onChange={onToggleDanmaku} title={translate(enabled ? '关闭弹幕' : '开启弹幕')} />
      </div>
      <label className="danmaku-setting">
        <span>{translate("行数 ")}<b>{settings.danmakuMaxLines}</b></span>
        <input type="range" min="1" max="8" step="1" value={settings.danmakuMaxLines}
          onChange={(event) => void onPatch({ danmakuMaxLines: Number(event.target.value) })} />
      </label>
      <label className="danmaku-setting">
        <span>{translate("速度 ")}<b>{settings.danmakuSpeed.toFixed(1)}x</b></span>
        <input type="range" min="0.5" max="3" step="0.1" value={settings.danmakuSpeed}
          onChange={(event) => void onPatch({ danmakuSpeed: Number(event.target.value) })} />
      </label>
      <label className="danmaku-setting">
        <span>{translate("字号 ")}<b>{Math.round(settings.danmakuSize * 100)}%</b></span>
        <input type="range" min="0.5" max="1.5" step="0.05" value={settings.danmakuSize}
          onChange={(event) => void onPatch({ danmakuSize: Number(event.target.value) })} />
      </label>
      <label className="danmaku-setting">
        <span>{translate("透明度 ")}<b>{Math.round(settings.danmakuOpacity * 100)}%</b></span>
        <input type="range" min="0.2" max="1" step="0.05" value={settings.danmakuOpacity}
          onChange={(event) => void onPatch({ danmakuOpacity: Number(event.target.value) })} />
      </label>
      <div className="danmaku-setting danmaku-color-setting">
        <span>{translate("随机颜色")}</span>
        <Switch checked={settings.danmakuRandomColor} onChange={(next) => void onPatch({ danmakuRandomColor: next })} />
      </div>
    </div>
  )
}
