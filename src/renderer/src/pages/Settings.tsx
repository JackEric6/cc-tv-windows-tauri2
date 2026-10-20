import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import type { AppSettings, ConfigSource, ParseInfo, ParseTestResult, PlayerInfo } from '@shared/types'
import { useApp } from '@/store/useApp'
import { Switch } from '@/components/Switch'
import { Icon } from '@/components/icons'
import { relativeTime } from '@/utils/format'
import { SITE_TYPE_LABEL } from '@shared/siteLabels'
import { translate } from '@/i18n'
import { submitFeedback as sendFeedback } from '@/services/feedback'
import { circledOrdinal, sourceOrdinal } from '@shared/searchSourcePolicy'

interface SettingsProps {
  onUpdateFound: (update: { version: string; currentVersion: string; notes: string }) => void
}

export function Settings({ onUpdateFound }: SettingsProps): JSX.Element {
  const sources = useApp((s) => s.sources)
  const settings = useApp((s) => s.settings)
  const info = useApp((s) => s.info)
  const syncing = useApp((s) => s.syncing)
  const syncAll = useApp((s) => s.syncAll)
  const syncSource = useApp((s) => s.syncSource)
  const refreshAll = useApp((s) => s.refreshAll)
  const updateSettings = useApp((s) => s.updateSettings)
  const setSessionFilterAdult = useApp((s) => s.setSessionFilterAdult)
  const notify = useApp((s) => s.notify)
  const presets = useApp((s) => s.presets)
  const addPreset = useApp((s) => s.addPreset)
  const sites = useApp((s) => s.sites)
  const loadHome = useApp((s) => s.loadHome)
  const homeLoading = useApp((s) => s.homeLoading)

  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [addingPreset, setAddingPreset] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string; url: string } | null>(null)
  const [feedback, setFeedback] = useState('')
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [feedbackSending, setFeedbackSending] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'general' | 'sources' | 'about'>('general')
  const [settingsUnlocked, setSettingsUnlocked] = useState(() => sessionStorage.getItem('cc-tv.settings-unlocked') === 'true')
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null)

  useEffect(() => {
    const unlock = (): void => setSettingsUnlocked(true)
    window.addEventListener('cc-tv:settings-unlocked', unlock)
    return () => window.removeEventListener('cc-tv:settings-unlocked', unlock)
  }, [])

  useEffect(() => {
    if (settings && !settingsDraft) setSettingsDraft(settings)
  }, [settings, settingsDraft])

  const stats = useMemo(() => {
    const usable = sites.filter((site) => site.enabled && !site.unsupported)
    const searchable = usable.filter((site) => site.searchable)
    const tested = sites.filter((site) => typeof site.health === 'number' && site.health >= 0)
    const avg = tested.length
      ? Math.round(tested.reduce((sum, site) => sum + (site.health ?? 0), 0) / tested.length)
      : 0
    return { usable: usable.length, searchable: searchable.length, avg, tested: tested.length }
  }, [sites])

  const busy = Object.keys(syncing).length > 0

  const settingsDirty = Boolean(settings && settingsDraft && JSON.stringify(settingsDraft) !== JSON.stringify(settings))

  async function patchImmediateSettings(patch: Partial<AppSettings>): Promise<void> {
    await updateSettings(patch)
    setSettingsDraft((current) => current ? { ...current, ...patch } : current)
  }

  async function saveSettingsDraft(): Promise<void> {
    if (!settingsDraft || !settingsDirty) return
    try {
      await updateSettings(settingsDraft)
      notify(translate('设置已保存'), 'success')
    } catch (err) {
      notify(`设置保存失败：${(err as Error).message}`, 'danger')
    }
  }

  async function submitFeedback(): Promise<void> {
    const content = feedback.trim()
    if (!content || feedbackSending) return
    if (content === '5858') {
      sessionStorage.setItem('cc-tv.settings-unlocked', 'true')
      setSettingsUnlocked(true)
      window.dispatchEvent(new Event('cc-tv:settings-unlocked'))
      setFeedback('')
      setFeedbackMessage(translate('隐藏功能已在本次运行中显示'))
      return
    }
    if (content === '4848') {
      setSessionFilterAdult(false)
      setFeedback('')
      setFeedbackMessage(translate('18+ 内容过滤已关闭，退出软件后将恢复开启'))
      return
    }
    const sourceKey = ({ '7701': 'guazi', '8801': 'xgzy' } as Record<string, string>)[content]
    if (sourceKey) {
      const source = sites.find((item) => item.key === sourceKey && item.enabled && item.homeEnabled && !item.unsupported)
      if (!source) {
        setFeedbackMessage(`当前没有启用的${sourceKey === 'guazi' ? '瓜子' : '西瓜'}源`)
        return
      }
      await updateSettings({ homeSourceKey: sourceKey as AppSettings['homeSourceKey'] })
      await loadHome(true)
      setFeedback('')
      setFeedbackMessage(`首页源已切换为${source.name}`)
      return
    }

    setFeedbackSending(true)
    try {
      await sendFeedback(content, useApp.getState().info?.version ?? '未知')
      setFeedback('')
      setFeedbackMessage('已提交')
    } catch (error) {
      setFeedbackMessage(`反馈提交失败：${(error as Error).message.replace(/^反馈提交失败：\s*/, '')}`)
    } finally {
      setFeedbackSending(false)
    }
  }

  async function add(): Promise<void> {
    const value = url.trim()
    if (!value) {
      notify(translate('请先填写订阅地址或选择本地文件'), 'warn')
      return
    }
    setAdding(true)
    try {
      const created = await window.api.sources.add({
        name: name.trim() || undefined,
        url: value,
        kind: /^https?:\/\//i.test(value) ? 'url' : 'file'
      })
      setName('')
      setUrl('')
      await refreshAll()
      notify(`已添加「${created.name}」，正在拉取配置…`, 'success')
      await syncSource(created.id)
    } catch (err) {
      notify((err as Error).message, 'danger')
    } finally {
      setAdding(false)
    }
  }

  async function pick(): Promise<void> {
    const picked = await window.api.sources.pickFile()
    if (!picked) return
    setUrl(picked)
    if (!name.trim()) setName(guessName(picked))
  }

  async function remove(source: ConfigSource): Promise<void> {
    if (!window.confirm(`确定要删除配置源「${source.name}」吗？该操作不影响磁盘上的原始文件。`)) return
    await window.api.sources.remove(source.id)
    await refreshAll()
    notify(`已删除「${source.name}」`, 'success')
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return
    try {
      await window.api.sources.update(editing.id, { name: editing.name, url: editing.url })
      setEditing(null)
      await refreshAll()
      notify(translate('已保存修改'), 'success')
    } catch (err) {
      notify((err as Error).message, 'danger')
    }
  }

  async function toggle(source: ConfigSource, enabled: boolean): Promise<void> {
    await window.api.sources.update(source.id, { enabled })
    await refreshAll()
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">{translate("设置")}</div>
          <div className="page-sub">{translate("外观、播放、影视源与解析服务")}</div>
        </div>
        {settingsTab === 'general' && settings && settingsDraft ? (
          <div className="page-actions settings-page-actions">
            {settingsDirty ? <span className="text-3 fs-13">{translate("有未保存的修改")}</span> : null}
            <button type="button" className="btn btn-primary" disabled={!settingsDirty} onClick={() => void saveSettingsDraft()}>{translate("\n              保存设置\n            ")}</button>
            <button type="button" className="btn" disabled={!settingsDirty} onClick={() => setSettingsDraft(settings)}>{translate("\n              放弃修改\n            ")}</button>
          </div>
        ) : null}
      </div>

      <div className="settings-tabs" role="tablist" aria-label={translate("设置分类")}>
        <button type="button" role="tab" aria-selected={settingsTab === 'general'} className={settingsTab === 'general' ? 'active' : ''} onClick={() => setSettingsTab('general')}>{translate("\n          常规与播放\n        ")}</button>
        {settingsUnlocked ? <button type="button" role="tab" aria-selected={settingsTab === 'sources'} className={settingsTab === 'sources' ? 'active' : ''} onClick={() => setSettingsTab('sources')}>{translate("\n          影视源与解析\n        ")}</button> : null}
        <button type="button" role="tab" aria-selected={settingsTab === 'about'} className={settingsTab === 'about' ? 'active' : ''} onClick={() => setSettingsTab('about')}>{translate("\n          反馈与关于\n        ")}</button>
      </div>

      {settingsTab === 'sources' ? <>
      <section className="settings-overview" aria-label={translate("丛丛影视概览")}>
        <div className="hero">
          <h1 className="hero-title">{translate("丛丛影视")}</h1>
          <p className="hero-sub">{translate("\n            Windows 桌面版 · 已内置 ")}{sites.length}{translate(" 个影视源 · M3U8 净化与弹幕默认开启。\n          ")}</p>
          <div className="hero-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => document.getElementById('config-sources')?.scrollIntoView({ behavior: 'smooth' })}
            >{translate("\n              管理配置源\n            ")}</button>
            <NavLink to="/sites" className="btn">{translate("\n              管理影视源（")}{stats.usable}）
            </NavLink>
            <button type="button" className="btn" disabled={busy} onClick={() => void syncAll()}>
              {busy ? <span className="spin" /> : <Icon name="refresh" size={15} />}{translate(" 同步全部配置\n            ")}</button>
            <button type="button" className="btn" disabled={homeLoading} onClick={() => void loadHome(true)}>
              {homeLoading ? <span className="spin" /> : <Icon name="refresh" size={15} />}{translate(" 刷新内容位\n            ")}</button>
          </div>
        </div>

        <div className="stat-grid">
          <div className="stat">
            <div className="stat-label">{translate("配置源")}</div>
            <div className="stat-value">
              {sources.length}
              <small>{translate("个 / 启用 ")}{sources.filter((source) => source.enabled).length}</small>
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">{translate("影视源总数")}</div>
            <div className="stat-value">{sites.length}<small>{translate("个")}</small></div>
          </div>
          <div className="stat">
            <div className="stat-label">{translate("可用影视源")}</div>
            <div className="stat-value">{stats.usable}<small>{translate("其中可搜索 ")}{stats.searchable}</small></div>
          </div>
          <div className="stat">
            <div className="stat-label">{translate("平均响应")}</div>
            <div className="stat-value" style={{ color: stats.avg ? 'var(--success)' : undefined }}>
              {stats.avg || '—'}
              <small>{stats.avg ? 'ms' : `已测 ${stats.tested} 个`}</small>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="section-title">{translate("配置源状态")}</div>
          <div className="section-more">{translate("\n            最近同步：")}{relativeTime(sources.reduce((max, source) => Math.max(max, source.lastSync), 0))}
          </div>
        </div>
        <div className="panel">
          <div className="list">
            {sources.map((source) => (
              <div className="list-row" key={source.id}>
                <span className={`dot ${source.error ? 'bad' : source.lastSync ? 'ok' : ''}`} />
                <div className="list-row-main">
                  <div className="list-row-title">{source.name}</div>
                  <div className="list-row-sub">{source.kind === 'url' ? source.url : `本地文件 · ${source.url}`}</div>
                </div>
                {source.error ? <span className="tag tag-danger" title={source.error}>{translate("同步失败")}</span> : null}
                <span className="tag tag-outline">{source.siteCount}{translate(" 站")}</span>
                <span className="tag tag-outline">{source.parseCount}{translate(" 解析")}</span>
                <span className="fs-12 text-3 nowrap">{relativeTime(source.lastSync)}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="section-title">{translate("影视源概览（按类型）")}</div>
          <NavLink to="/sites">{translate("全部影视源 →")}</NavLink>
        </div>
        <div className="stat-grid">
          {([3, 1, 4, 0, 2] as const).map((type) => {
            const group = sites.filter((site) => site.type === type)
            if (!group.length) return null
            return (
              <div className="stat" key={type}>
                <div className="stat-label">{translate(SITE_TYPE_LABEL[type])}</div>
                <div className="stat-value">{group.length}<small>{translate("启用 ")}{group.filter((site) => site.enabled).length}</small></div>
              </div>
            )
          })}
        </div>
      </section>
      </> : null}

      {settingsTab === 'about' ? <>
      <section className="section">
        <div className="section-head">
          <div className="section-title">{translate("开发里程碑")}</div>
          <div className="section-more">{translate("当前版本：1.0.26")}</div>
        </div>
        <div className="milestones">
          <div className="milestone done">
            <div className="milestone-head"><span className="milestone-code">M1</span><span className="tag tag-success">{translate("已完成")}</span></div>
            <div className="milestone-title">{translate("桌面基础与配置管理")}</div>
            <div className="milestone-desc">{translate("Tauri 2 桌面应用、配置导入同步、影视源管理、解析接口和基础设置。")}</div>
          </div>
          <div className="milestone done">
            <div className="milestone-head"><span className="milestone-code">M2</span><span className="tag tag-success">{translate("已完成")}</span></div>
            <div className="milestone-title">{translate("首页、分类与聚合搜索")}</div>
            <div className="milestone-desc">{translate("多源片单、分类浏览、站点搜索开关、单源超时控制和搜索结果筛选。")}</div>
          </div>
          <div className="milestone done">
            <div className="milestone-head"><span className="milestone-code">M3</span><span className="tag tag-success">{translate("已完成")}</span></div>
            <div className="milestone-title">{translate("在线播放与播放控制")}</div>
            <div className="milestone-desc">{translate("线路和剧集切换、弹幕、画中画、全屏、进度预览、播放记忆与快捷控制。")}</div>
          </div>
          <div className="milestone done">
            <div className="milestone-head"><span className="milestone-code">M4</span><span className="tag tag-success">{translate("已完成")}</span></div>
            <div className="milestone-title">{translate("收藏、历史与离线播放")}</div>
            <div className="milestone-desc">{translate("收藏夹、观看历史与续播、下载队列和本地文件播放。")}</div>
          </div>
          <div className="milestone doing">
            <div className="milestone-head"><span className="milestone-code">M5</span><span className="tag tag-accent">{translate("当前迭代")}</span></div>
            <div className="milestone-title">{translate("体验优化与反馈闭环")}</div>
            <div className="milestone-desc">{translate("优化播放预览和跳转反馈，完善应用内反馈提交、更新检查与发布验证。")}</div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
        <div className="section-title">{translate("反馈建议")}</div>
        </div>
        <div className="panel">
          <div className="panel-body-pad">
            <div className="form-row" style={{ padding: 0 }}>
              <div className="field grow">
                <label>{translate("反馈建议")}</label>
                <textarea
                  className="input feedback-input"
                  rows={2}
                  value={feedback}
                  onChange={(event) => { setFeedback(event.target.value); setFeedbackMessage('') }}
                  placeholder={translate("请填写你遇到的问题或建议")}
                />
              </div>
              <button type="button" className="btn btn-primary" disabled={!feedback.trim() || feedbackSending} onClick={() => void submitFeedback()}>{feedbackSending ? translate('正在提交…') : translate("\n                提交\n              ")}</button>
            </div>
            {feedbackMessage ? <div className="field-hint" style={{ marginTop: 8 }}>{feedbackMessage}</div> : null}
          </div>
        </div>
      </section>
      </> : null}

      <div className="settings-grid">
        {settingsTab === 'sources' ? <section className="section" id="config-sources">
          <div className="section-head">
            <div className="section-title">{translate("配置源")}</div>
            <div className="section-more">{translate("\n              支持 TVBox 标准 JSON 与本项目的 tvbox-desktop/1 简洁格式\n            ")}</div>
          </div>

          <div className="panel">
            <div className="form-row">
              <div className="field" style={{ flex: '0 0 180px' }}>
                <label>{translate("名称（可选）")}</label>
                <input
                  className="input"
                  value={name}
                  placeholder={translate("留空则用配置里的 name")}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field grow">
                <label>{translate("订阅地址 / 本地文件路径")}</label>
                <input
                  className="input"
                  value={url}
                  placeholder={translate("https://example.com/tvbox.json 或 D:\\config\\api.json")}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void add()
                  }}
                />
              </div>
              <button type="button" className="btn" onClick={() => void pick()}>{translate("\n                选择文件…\n              ")}</button>
              <button type="button" className="btn btn-primary" disabled={adding} onClick={() => void add()}>
                {adding ? <span className="spin" /> : '+'}{translate(" 添加\n              ")}</button>
            </div>
          </div>

          {presets.length ? (
            <div className="panel" style={{ marginTop: 12 }}>
              <div className="panel-body-pad">
                <div className="field-hint" style={{ marginBottom: 8 }}>{translate("\n                  内置源\n                ")}</div>
                {presets.map((preset) => (
                  <div className="preset-row" key={preset.id}>
                    <div className="grow">
                      <div className="list-row-title">{preset.name}</div>
                      <div className="list-row-sub">{preset.desc}</div>
                    </div>
                    <span className="tag tag-outline">
                      {preset.siteCount}{translate(" 个站点\n                    ")}</span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={addingPreset === preset.id}
                      onClick={async () => {
                        setAddingPreset(preset.id)
                        await addPreset(preset.id)
                        setAddingPreset('')
                      }}
                    >
                      {addingPreset === preset.id ? <span className="spin" /> : <Icon name="plus" size={13} />}{translate("\n                      添加\n                    ")}</button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="panel" style={{ marginTop: 12 }}>
            <div className="list">
              {sources.map((source) => (
                <div className="list-row" key={source.id}>
                  <Switch
                    checked={source.enabled}
                    onChange={(v) => void toggle(source, v)}
                    title={translate("启用 / 停用该配置源")}
                  />
                  {editing?.id === source.id ? (
                    <>
                      <div className="field grow">
                        <input
                          className="input"
                          value={editing.name}
                          placeholder={translate("名称")}
                          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        />
                      </div>
                      <div className="field grow" style={{ flex: 2 }}>
                        <input
                          className="input"
                          value={editing.url}
                          onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                        />
                      </div>
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => void saveEdit()}>{translate("\n                        保存\n                      ")}</button>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>{translate("\n                        取消\n                      ")}</button>
                    </>
                  ) : (
                    <>
                      <div className="list-row-main">
                        <div className="list-row-title">
                          <span className="truncate">{source.name}</span>
                          <span className="tag tag-outline">{source.kind === 'url' ? '订阅' : '本地'}</span>
                          {source.error ? <span className="tag tag-danger">{translate("异常")}</span> : null}
                        </div>
                        <div className="list-row-sub truncate" title={source.url}>
                          {source.url}
                        </div>
                      </div>
                      <span className="fs-12 text-3 nowrap">{translate("\n                        站点 ")}{source.siteCount}{translate(" · 解析 ")}{source.parseCount}
                      </span>
                      <span className="fs-12 text-3 nowrap">{relativeTime(source.lastSync)}</span>
                      <div className="list-row-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={Boolean(syncing[source.id])}
                          onClick={() => void syncSource(source.id)}
                        >
                          {syncing[source.id] ? <span className="spin" /> : <Icon name="refresh" size={13} />}{translate(" 同步\n                        ")}</button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setEditing({ id: source.id, name: source.name, url: source.url })}
                        >{translate("\n                          编辑\n                        ")}</button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(source)}>{translate("\n                          删除\n                        ")}</button>
                      </div>
                    </>
                  )}
                </div>
              ))}

              {!sources.length ? (
                <div className="empty" style={{ padding: 24 }}>
                  <div className="empty-desc">{translate("还没有配置源，用上面的表单添加一个吧。")}</div>
                </div>
              ) : null}
            </div>
          </div>

          {sources.some((s) => s.error) ? (
            <div className="banner banner-warn" style={{ marginTop: 12 }}>
              <b>{translate("同步失败详情：")}</b>
              {sources
                .filter((s) => s.error)
                .map((s) => `${s.name}：${s.error}`)
                .join('　|　')}
            </div>
          ) : null}
        </section> : null}

        {settingsTab === 'sources' ? <ParseSettingsSection /> : null}
        {settingsTab === 'general' && settings && settingsDraft ? (
          <GeneralSettings
            settings={settings}
            draft={settingsDraft}
            setDraft={(next) => setSettingsDraft(next)}
            onImmediatePatch={patchImmediateSettings}
            onUpdateFound={onUpdateFound}
          />
        ) : null}
        {settingsTab === 'general' && settings && settingsDraft ? (
          <AiSettingsSection settings={settings} draft={settingsDraft} setDraft={(next) => setSettingsDraft(next)} />
        ) : null}
        {settingsTab === 'sources' ? <section className="section">
          <div className="section-head">
            <div className="section-title">{translate("配置格式")}</div>
            <div className="section-more">{translate("历史配置格式说明见 docs/legacy/功能框架.txt 第 5 章")}</div>
          </div>
          <div className="panel">
            <div className="code-block">{JSON_SAMPLE}</div>
            <div className="fs-12 text-3" style={{ marginTop: 10, lineHeight: 1.8 }}>
              <div>
                · <b>{translate("A 方言")}</b>{translate("：与安卓版 TVBox 相同的配置结构，可直接导入现成订阅。\n              ")}</div>
              <div>
                · <b>{translate("B 方言")}</b>{translate("：加上 ")}<span className="mono">"format": "tvbox-desktop/1"</span>{translate("，\n                站点可以只写 ")}<span className="mono">"type": "cms"</span>{translate(" 或 ")}<span className="mono">"html"</span>{translate("，\n                其余字段自动归一化。\n              ")}</div>
              <div>{translate("\n                · 桌面端无法运行 Java jar / dex 形式的 spider，\n                ")}<span className="mono">type=0</span>{translate(" 的站点会被标记「需 Spider」并跳过。\n              ")}</div>
            </div>
          </div>
        </section> : null}

        {settingsTab === 'about' ? <section className="section">
          <div className="section-head">
            <div className="section-title">{translate("关于")}</div>
            <div className="section-more">
              <NavLink to="/sites">{translate("查看影视源 →")}</NavLink>
            </div>
          </div>
          <div className="panel">
            <div className="kv">
              <div className="kv-key">{translate("版本")}</div>
              <div className="kv-value mono">v{info?.version ?? '—'}</div>
            </div>
            <div className="kv">
              <div className="kv-key">{translate("运行环境")}</div>
              <div className="kv-value mono">
                Tauri · WebView2 {info?.webview2 ?? '—'} · Node {info?.node ?? '—'}
              </div>
            </div>
            <div className="kv">
              <div className="kv-key">{translate("数据目录")}</div>
              <div className="kv-value mono truncate" title={info?.userData}>
                {info?.userData ?? '—'}
              </div>
            </div>
            <div className="kv">
              <div className="kv-key">{translate("开源组件")}</div>
              <div className="kv-value">
                Tauri 2 · WebView2 · React · Video.js · VHS · cheerio
              </div>
            </div>
          </div>
        </section> : null}
      </div>
    </div>
  )
}

const JSON_SAMPLE = `{
  "format": "tvbox-desktop/1",
  "name": "我的配置",
  "sites": [
    { "key": "demo", "name": "示例站", "type": "cms",
      "api": "https://demo.example.com/api.php/provide/vod" },
    { "key": "html", "name": "网页站", "type": "html",
      "api": "https://demo.example.com/search?wd={wd}",
      "rules": { "list": ".result li", "name": "a", "link": "a" } }
  ],
  "parses": [ { "name": "解析线路", "type": 1, "url": "https://example.com/jx?url=" } ]
}`

interface GeneralProps {
  settings: AppSettings
  draft: AppSettings
  setDraft: (draft: AppSettings) => void
  onImmediatePatch: (patch: Partial<AppSettings>) => Promise<void>
  onUpdateFound: (update: { version: string; currentVersion: string; notes: string }) => void
}

interface AiSettingsProps {
  settings: AppSettings
  draft: AppSettings
  setDraft: (draft: AppSettings) => void
}

/** 一条解析接口的战绩，写成人话 */
function statText(stat: ParseInfo['stat']): string {
  const total = stat.ok + stat.fail
  if (!total) return translate('还没测过')
  const parts = [`${translate('成功')} ${stat.ok}`, `${translate('失败')} ${stat.fail}`]
  if (stat.lastOk) parts.push(`${translate('最近')} ${stat.lastMs}ms`)
  return parts.join(' · ')
}

/**
 * 解析接口管理。
 *
 * 这一块在界面上要讲清楚一件事：**大部分网页地址根本不需要解析接口**。
 * 采集站的分享页十有八九是个 DPlayer 壳，地址明文写在脚本里，应用自己读一遍就有了。
 * 解析接口是「读不出来时」的兜底，所以文案的顺序也是这么写的。
 */
function ParseSettingsSection(): JSX.Element {
  const notify = useApp((s) => s.notify)
  const sources = useApp((s) => s.sources)
  const [list, setList] = useState<ParseInfo[]>([])
  const [busy, setBusy] = useState('')
  const [results, setResults] = useState<Record<string, ParseTestResult>>({})
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [flags, setFlags] = useState('')
  const [adding, setAdding] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    setList(await window.api.parse.list())
  }, [])

  // sources 作为依赖：同步完配置源以后，配置里带的解析接口应该立刻出现在这里
  useEffect(() => {
    void reload()
  }, [reload, sources])

  const test = async (item: ParseInfo): Promise<void> => {
    setBusy(item.url)
    try {
      const r = await window.api.parse.test(item.url)
      setResults((prev) => ({ ...prev, [item.url]: r }))
      await reload()
    } catch (err) {
      notify((err as Error).message, 'danger')
    } finally {
      setBusy('')
    }
  }

  const testAll = async (): Promise<void> => {
    for (const item of list) await test(item)
    notify(translate('全部测完了，排行已经按结果更新'), 'success')
  }

  const add = async (): Promise<void> => {
    if (!url.trim()) return
    setAdding(true)
    try {
      setList(await window.api.parse.add({ name, url, flags: flags.split(/[\s,|]+/).filter(Boolean) }))
      setName('')
      setUrl('')
      setFlags('')
      notify(translate('解析接口已添加'), 'success')
    } catch (err) {
      notify((err as Error).message, 'danger')
    } finally {
      setAdding(false)
    }
  }

  const remove = async (item: ParseInfo): Promise<void> => {
    if (!window.confirm(`${translate('删除解析接口')}「${item.name}」${translate('？')}`)) return
    setList(await window.api.parse.remove(item.url))
    notify(translate('已删除'), 'success')
  }

  const custom = list.filter((p) => p.origin === 'custom').length

  return (
    <section className="section">
      <div className="section-head">
        <div className="section-title">{translate("解析接口")}</div>
        <div className="section-more">
          {list.length ? `${list.length}${translate(' 条（配置里 ')}${list.length - custom} · ${translate('手动 ')}${custom}）` : translate('一条都没有')}
        </div>
      </div>
      <div className="panel panel-body-pad">
        <div className="fs-12 text-3" style={{ lineHeight: 1.8, marginBottom: 12 }}>{translate("\n          有些采集站给的线路不是直链，而是一个分享页地址。播放时应用会\n          ")}<b>{translate("先自己去读一遍那个页面")}</b>{translate("（很多分享页就是个播放器壳，地址明文写在里面），\n          读不出来才按下面的排行依次问解析接口。失败的接口会排到后面，越用越准。\n        ")}</div>

        {list.length ? (
          <div className="list">
            {list.map((item) => {
              const r = results[item.url]
              return (
                <div className="list-row" key={item.url}>
                  <div className="list-row-main">
                    <div className="list-row-title">
                      {item.name}
                      <span className={`tag ${item.origin === 'custom' ? 'tag-accent' : 'tag-outline'}`}>
                        {translate(item.origin === 'custom' ? '手动添加' : '配置里带的')}
                      </span>
                      {item.type === 0 ? <span className="tag tag-warn">{translate("type=0 需浏览器嗅探")}</span> : null}
                    </div>
                    <div className="list-row-sub mono truncate">{item.url}</div>
                    <div className="list-row-sub">
                      {item.flags.length ? `${translate('只解析 ')}${item.flags.join(' / ')}` : translate('通配所有线路')}
                      {' · '}
                      {statText(item.stat)}
                    </div>
                    {r ? (
                      <div className={`list-row-sub ${r.ok ? '' : 'text-3'}`}>
                        {r.ok ? (
                          <span className="mono truncate">✓ {r.ms}{translate("ms 换到 ")}{r.url}</span>
                        ) : (
                          <span>✗ {r.error}</span>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="list-row-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy === item.url}
                      onClick={() => void test(item)}
                    >
                      {busy === item.url ? <span className="spin" /> : <Icon name="check" size={13} />}{translate("\n                      测一下\n                    ")}</button>
                    {item.origin === 'custom' ? (
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(item)}>
                        <Icon name="trash" size={13} />
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="fs-13 text-3">{translate("\n            还没解析接口。你的 TVBox 订阅里如果有 ")}<span className="mono">parses</span>{translate(" 字段，\n            同步后会自动出现在这里；也可以手动加一条。\n          ")}</div>
        )}

        <div className="divider" />

        <div className="form-row">
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{translate("名称")}</label>
            <input
              className="input"
              placeholder={translate("例如 某解析")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label>{translate("接口地址")}</label>
            <input
              className="input mono"
              placeholder="https://…/?url="
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: '0 0 150px' }}>
            <label>{translate("只解析哪些线路")}</label>
            <input
              className="input mono"
              placeholder={translate("留空 = 全部")}
              value={flags}
              onChange={(e) => setFlags(e.target.value)}
            />
          </div>
          <button type="button" className="btn btn-primary" disabled={adding || !url.trim()} onClick={() => void add()}>
            <Icon name="plus" size={14} />{translate("\n            添加\n          ")}</button>
        </div>

        {list.length ? (
          <div className="hstack" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void testAll()}>
              <Icon name="check" size={13} />{translate("\n              逐个测一遍\n            ")}</button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                setResults({})
                setList(await window.api.parse.resetStats())
                notify(translate('排行已清空'), 'success')
              }}
            >{translate("\n              清空排行\n            ")}</button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function GeneralSettings({ settings, draft, setDraft, onImmediatePatch, onUpdateFound }: GeneralProps): JSX.Element {
  const notify = useApp((s) => s.notify)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateStatus, setUpdateStatus] = useState('')

  const checkUpdates = async (): Promise<void> => {
    setUpdateBusy(true)
    setUpdateStatus(translate('正在检查 GitHub Release…'))
    try {
      const update = await window.api.updater.check()
      if (!update.hasUpdate) {
        setUpdateStatus(`${translate('当前已是最新版本')} v${update.currentVersion}`)
        return
      }
      const skippedVersion = localStorage.getItem('cc-tv-skipped-update-version')
      if (skippedVersion === update.latestVersion) {
        setUpdateStatus(`${translate('已跳过版本')} v${update.latestVersion}`)
        return
      }
      setUpdateStatus(`${translate('发现新版本')} v${update.latestVersion}`)
      onUpdateFound({ version: update.latestVersion, currentVersion: update.currentVersion, notes: update.notes.slice(0, 1600) })
    } catch (error) {
      const message = (error as Error).message
      setUpdateStatus(`${translate('检查更新失败：')}${message}`)
      notify(`${translate('检查更新失败：')}${message}`, 'danger')
    } finally {
      setUpdateBusy(false)
    }
  }

  const dirty = JSON.stringify(draft, (key, value) => key === 'theme' || key === 'ai' ? undefined : value)
    !== JSON.stringify(settings, (key, value) => key === 'theme' || key === 'ai' ? undefined : value)

  const saveTheme = async (theme: AppSettings['theme']): Promise<void> => {
    if (settings.theme === theme) return
    try {
      await onImmediatePatch({ theme })
    } catch (err) {
      notify(`主题保存失败：${(err as Error).message}`, 'danger')
    }
  }

  const saveLanguage = async (language: AppSettings['language']): Promise<void> => {
    if (settings.language === language) return
    try {
      await onImmediatePatch({ language })
    } catch (err) {
      notify(`${translate('语言保存失败：')}${(err as Error).message}`, 'danger')
    }
  }

  const saveHomeSource = async (homeSourceKey: AppSettings['homeSourceKey']): Promise<void> => {
    if (settings.homeSourceKey === homeSourceKey) return
    try {
      await onImmediatePatch({ homeSourceKey })
    } catch (err) {
      notify(`首页源切换失败：${(err as Error).message}`, 'danger')
    }
  }

  // 点「检测本机播放器」之前不主动扫，因为这个动作要摸一遍磁盘上的常见安装路径
  const [players, setPlayers] = useState<PlayerInfo[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const detect = async (): Promise<void> => {
    setDetecting(true)
    try {
      setPlayers(await window.api.player.detect())
    } finally {
      setDetecting(false)
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <div className="section-title">{translate("通用")}</div>
        <div className="section-more">{dirty ? '有未保存的修改' : '已保存'}</div>
      </div>
      <div className="panel">
        <div className="form-row settings-general-grid">
          <div className="settings-subhead">{translate("界面与网络")}</div>
          <div className="field">
            <label>{translate("首页片单来源")}</label>
            <select
              className="input"
              value={settings.homeSourceKey}
              onChange={(event) => void saveHomeSource(event.target.value as AppSettings['homeSourceKey'])}
            >
              <option value="guazi">{circledOrdinal(sourceOrdinal('guazi')!)}</option>
              <option value="xgzy">{circledOrdinal(sourceOrdinal('xgzy')!)}</option>
              <option value="dyttzy">{circledOrdinal(sourceOrdinal('dyttzy')!)}</option>
              <option value="ffzy">{circledOrdinal(sourceOrdinal('ffzy')!)}</option>
              <option value="lzi">{circledOrdinal(sourceOrdinal('lzi')!)}</option>
              <option value="bfzy">{circledOrdinal(sourceOrdinal('bfzy')!)}</option>
            </select>
            <div className="field-hint">{translate("选择后立即刷新首页片单")}</div>
          </div>
          <div className="field">
            <label>{translate("聚合搜索并发数")}</label>
            <input
              className="input"
              type="number"
              min={1}
              max={32}
              value={draft.concurrency}
              onChange={(e) => setDraft({ ...draft, concurrency: clampInt(e.target.value, 1, 32, 10) })}
            />
            <div className="field-hint">{translate("同时请求的站点数量，过大可能被部分站点限流（1–32）")}</div>
          </div>
          <div className="field">
            <label>{translate("请求超时（秒）")}</label>
            <input
              className="input"
              type="number"
              min={3}
              max={120}
              value={draft.timeout}
              onChange={(e) => setDraft({ ...draft, timeout: clampInt(e.target.value, 3, 120, 3) })}
            />
            <div className="field-hint">{translate("普通接口与详情请求的等待时间；聚合搜索单源截止时间单独设置")}</div>
          </div>
          <div className="field">
            <label>{translate("单源请求截止（秒）")}</label>
            <input
              className="input"
              type="number"
              min={1}
              max={10}
              value={draft.singleSourceTimeoutSeconds}
              onChange={(e) => setDraft({ ...draft, singleSourceTimeoutSeconds: clampInt(e.target.value, 1, 10, 2) })}
            />
            <div className="field-hint">{translate("达到时限后跳过该站点，其他站点继续返回结果（1–10 秒）")}</div>
          </div>
          <div className="field">
            <label>{translate("界面密度")}</label>
            <select
              className="input"
              value={draft.density}
              onChange={(e) => setDraft({ ...draft, density: e.target.value as AppSettings['density'] })}
            >
              <option value="compact">{translate('紧凑（推荐，信息更多）')}</option>
              <option value="comfortable">{translate('宽松')}</option>
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label>{translate("网络代理")}</label>
            <div className="hstack" style={{ paddingTop: 6, gap: 10 }}>
              <Switch checked={draft.useSystemProxy} onChange={(next) => setDraft({ ...draft, useSystemProxy: next })} />
              <span className="fs-13 text-2">{translate(draft.useSystemProxy ? '使用系统代理' : '不使用代理')}</span>
            </div>
            <div className="field-hint">{translate("使用 Windows 当前配置的系统代理；默认直连")}</div>
          </div>
          <div className="field">
            <label>{translate("外观主题")}</label>
            <div className="segmented-control" role="group" aria-label={translate("外观主题")}>
              <button
                type="button"
                className={settings.theme === 'light' ? 'active' : ''}
                aria-pressed={settings.theme === 'light'}
                onClick={() => void saveTheme('light')}
              >{translate("白色")}</button>
              <button
                type="button"
                className={settings.theme === 'dark' ? 'active' : ''}
                aria-pressed={settings.theme === 'dark'}
                onClick={() => void saveTheme('dark')}
              >{translate("暗黑")}</button>
            </div>
          </div>
          <div className="field">
            <label>{translate("语言")}</label>
            <div className="segmented-control" role="group" aria-label={translate("语言")}>
              <button
                type="button"
                className={settings.language === 'zh-CN' ? 'active' : ''}
                aria-pressed={settings.language === 'zh-CN'}
                onClick={() => void saveLanguage('zh-CN')}
              >{translate("简体中文")}</button>
              <button
                type="button"
                className={settings.language === 'en-US' ? 'active' : ''}
                aria-pressed={settings.language === 'en-US'}
                onClick={() => void saveLanguage('en-US')}
              >English</button>
            </div>
          </div>
          <div className="field" style={{ flex: '0 0 140px' }}>
            <label>{translate("强调色")}</label>
            <div className="hstack">
              <input
                className="input"
                type="color"
                style={{ width: 48, padding: 2 }}
                value="#6A3DE8"
                disabled
              />
              <span className="mono fs-12">#6A3DE8</span>
            </div>
          </div>
          <div className="settings-subhead">{translate("播放体验")}</div>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label>{translate("搜索结果过滤解说")}</label>
            <div className="hstack" style={{ paddingTop: 6, gap: 10 }}>
              <Switch
                checked={draft.filterCommentary}
                onChange={(next) => setDraft({ ...draft, filterCommentary: next })}
              />
              <span className="fs-13 text-2">
                {translate(draft.filterCommentary ? '隐藏解说 / 速看 / 混剪' : '全部显示')}
              </span>
            </div>
            <div className="field-hint">{translate("开启后隐藏「XX解说」「一口气看完」等二创内容")}</div>
          </div>
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label>{translate("M3U8 净化")}</label>
            <div className="hstack" style={{ paddingTop: 6, gap: 10 }}>
              <Switch checked={draft.m3u8Purify} onChange={(next) => setDraft({ ...draft, m3u8Purify: next })} />
              <span className="fs-13 text-2">{translate(draft.m3u8Purify ? '开启' : '关闭')}</span>
            </div>
          </div>
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label>{translate("弹幕")}</label>
            <div className="hstack" style={{ paddingTop: 6, gap: 10 }}>
              <Switch checked={draft.danmakuEnabled} onChange={(next) => setDraft({ ...draft, danmakuEnabled: next })} />
              <span className="fs-13 text-2">{translate(draft.danmakuEnabled ? '自动匹配' : '关闭')}</span>
            </div>
          </div>
        </div>

        <div className="settings-update-row">
          <div>
            <div className="settings-subhead">{translate('软件更新')}</div>
            <div className="field-hint">{updateStatus || translate('启动后 3 秒自动检查 GitHub Release')}</div>
          </div>
          <button type="button" className="btn btn-sm" disabled={updateBusy} onClick={() => void checkUpdates()}>
            {updateBusy ? <span className="spin" /> : <Icon name="refresh" size={14} />}{translate(updateBusy ? '正在检查更新…' : '检查更新')}
          </button>
        </div>

        <div className="field" style={{ marginTop: 8 }}>
          <label>User-Agent</label>
          <input
            className="input"
            value={draft.userAgent}
            onChange={(e) => setDraft({ ...draft, userAgent: e.target.value })}
          />
          <div className="field-hint">{translate("部分站点会校验 UA，异常时可以先恢复默认")}</div>
        </div>

        <div className="divider" />

        <div className="field">
          <label>{translate("外部播放器命令")}</label>
          <input
            className="input"
            placeholder={translate("留空则自动探测 PotPlayer / mpv / VLC")}
            value={draft.externalPlayer.command}
            onChange={(e) =>
              setDraft({ ...draft, externalPlayer: { ...draft.externalPlayer, command: e.target.value } })
            }
          />
          <div className="field-hint">{translate("\n            参数模板用 ")}<span className="mono">{'{url}'}</span>{translate(" 代表播放地址，多个参数用空格分隔，例如")}{' '}
            <span className="mono">--fullscreen {'{url}'}</span>
          </div>
        </div>

        <div className="field">
          <label>{translate("本机播放器")}</label>
          <div className="hstack">
            <button type="button" className="btn btn-sm" disabled={detecting} onClick={() => void detect()}>
              {detecting ? <span className="spin" /> : <Icon name="search" size={14} />}{translate(" 检测本机播放器\n            ")}</button>
            {players ? (
              players.length ? (
                <span className="fs-12 text-3">{translate("找到 ")}{players.length}{translate(" 个")}</span>
              ) : (
                <span className="fs-12 text-3">{translate("\n                  一个都没找到（扫过 PotPlayer / mpv / VLC / MPC-HC / MPC-BE / KMPlayer / SMPlayer\n                  的常见安装路径，也问过 .mkv / .mp4 的默认打开方式），装在别处的话请直接填上面的路径\n                ")}</span>
              )
            ) : (
              <span className="fs-12 text-3">{translate("留空时按 PotPlayer → mpv → VLC 的顺序自动找")}</span>
            )}
          </div>
        </div>
        {players?.length ? (
          <div className="list">
            {players.map((p) => (
              <div className="list-row" key={p.path}>
                <div className="list-row-main">
                  <div className="list-row-title">
                    {p.name}
                    {p.source === 'registry' ? (
                      <span className="tag tag-outline">{translate("系统默认打开方式")}</span>
                    ) : null}
                  </div>
                  <div className="list-row-sub mono truncate" title={p.path}>
                    {p.path}
                  </div>
                </div>
                {draft.externalPlayer.command === p.path ? (
                  <span className="tag tag-success">{translate("已选")}</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        externalPlayer: { ...draft.externalPlayer, command: p.path }
                      })
                    }
                  >{translate("\n                    用这个\n                  ")}</button>
                )}
              </div>
            ))}
          </div>
        ) : null}

        <div className="field" style={{ maxWidth: 420 }}>
          <label>{translate("参数模板")}</label>
          <input
            className="input mono"
            value={(draft.externalPlayer.args ?? []).join(' ')}
            onChange={(e) =>
              setDraft({
                ...draft,
                externalPlayer: { ...draft.externalPlayer, args: e.target.value.split(/\s+/).filter(Boolean) }
              })
            }
          />
        </div>

      </div>
    </section>
  )
}

function AiSettingsSection({ settings, draft, setDraft }: AiSettingsProps): JSX.Element {
  const [showKey, setShowKey] = useState(false)

  const dirty = JSON.stringify(draft.ai) !== JSON.stringify(settings.ai)
  const hasKey = (settings.ai?.apiKey ?? '').trim().length > 0

  const patchAi = (part: Partial<AppSettings['ai']>): void => {
    setDraft({ ...draft, ai: { ...draft.ai, ...part } })
  }

  return (
    <section className="section">
      <div className="section-head">
        <div className="section-title">{translate("AI 总结")}</div>
        <div className="section-more">
          {translate(dirty ? '有未保存的修改' : hasKey ? '已配置' : '还没配置 API Key')}
        </div>
      </div>
      <div className="panel panel-body-pad">
        <div className="field">
          <label>DeepSeek API Key</label>
          <div className="hstack">
            <input
              className="input mono grow"
              type={showKey ? 'text' : 'password'}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              value={draft.ai.apiKey}
              onChange={(e) => patchAi({ apiKey: e.target.value })}
            />
            <button type="button" className="btn btn-sm" onClick={() => setShowKey((v) => !v)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <div className="field-hint">{translate("\n            在 ")}<span className="mono">platform.deepseek.com</span>{translate(" 的「API keys」里创建。只保存在本机")}{' '}
            <span className="mono">data/settings.json</span>{translate("，不会上传到任何地方。\n          ")}</div>
        </div>

        <div className="field" style={{ maxWidth: 260 }}>
          <label>{translate("模型")}</label>
          <input
            className="input mono"
            list="ai-models"
            value={draft.ai.model}
            onChange={(e) => patchAi({ model: e.target.value })}
          />
          <datalist id="ai-models">
            <option value="deepseek-flash" />
            <option value="deepseek-v4-pro" />
          </datalist>
          <div className="field-hint">{translate("deepseek-flash 最便宜也够用；deepseek-v4-pro 更准但贵几倍")}</div>
        </div>

        <div className="field">
          <label>{translate("接口地址")}</label>
          <input
            className="input mono"
            placeholder={translate("留空 = https://api.deepseek.com")}
            value={draft.ai.baseUrl}
            onChange={(e) => patchAi({ baseUrl: e.target.value })}
          />
          <div className="field-hint">{translate("换成任何 OpenAI 兼容的服务都可以，会自动拼 /chat/completions")}</div>
        </div>

        <div className="banner banner-info">{translate("\n          点播放页的「AI 总结本集」时，会把片名、集名、类型、年份、演员和站点简介发给 DeepSeek，\n          用来生成这一集的剧情。不会发送播放地址，也不会在后台自动调用。\n        ")}</div>

      </div>
    </section>
  )
}

function clampInt(value: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 从文件路径猜一个名字，省得用户手打 */
function guessName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? '配置'
  return base.replace(/\.(json|txt)$/i, '')
}
