import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { OfflineTask } from '@shared/types'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/icons'
import { sourceDisplayLabel } from '@shared/searchSourcePolicy'
import { useApp } from '@/store/useApp'
import { translate } from '@/i18n'

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return translate('计算中')
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`
}

function statusText(task: OfflineTask): string {
  if (task.status === 'downloading') return translate('缓存中')
  if (task.status === 'queued') return translate('排队中')
  if (task.status === 'paused') return translate('已暂停')
  if (task.status === 'completed') return translate('已完成')
  if (task.status === 'cancelled') return translate('已取消')
  return translate('失败')
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return translate('计算中')
  const value = Math.ceil(seconds)
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const remainder = value % 60
  return hours ? `${hours}${translate('小时')}${minutes}${translate('分')}` : minutes ? `${minutes}${translate('分')}${remainder}${translate('秒')}` : `${remainder}${translate('秒')}`
}

function expectedBytes(task: OfflineTask): number {
  return task.totalBytes > 0 ? task.totalBytes : task.estimatedTotalBytes ?? -1
}

function formatTaskTotal(task: OfflineTask): string {
  if (task.totalBytes > 0) return formatBytes(task.totalBytes)
  if ((task.estimatedTotalBytes ?? -1) > 0) return `${translate('约 ')}${formatBytes(task.estimatedTotalBytes!)}`
  return translate('总大小未知')
}

export function Downloads(): JSX.Element {
  const notify = useApp((state) => state.notify)
  const [tasks, setTasks] = useState<OfflineTask[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [filter, setFilter] = useState<'active' | 'completed' | 'other'>('active')
  const [speeds, setSpeeds] = useState<Record<string, number>>({})
  const speedSamples = useRef(new Map<string, { bytes: number; at: number }>())

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.offline.list()
      const now = Date.now()
      const rates: Record<string, number> = {}
      const samples = new Map<string, { bytes: number; at: number }>()
      for (const task of next) {
        const previous = speedSamples.current.get(task.id)
        const active = task.status === 'downloading' || task.status === 'queued'
        rates[task.id] = active && previous && now > previous.at
          ? Math.max(0, (task.downloadedBytes - previous.bytes) * 1000 / (now - previous.at))
          : 0
        samples.set(task.id, { bytes: task.downloadedBytes, at: now })
      }
      speedSamples.current = samples
      setSpeeds(rates)
      setTasks(next)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!tasks.some((task) => task.status === 'queued' || task.status === 'downloading')) return
    const timer = window.setInterval(() => { void refresh() }, 900)
    return () => window.clearInterval(timer)
  }, [tasks, refresh])

  const runAction = async (id: string, action: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(id)
    try {
      await action()
      await refresh()
      if (message) notify(message, 'success')
    } catch (error) {
      notify((error as Error).message, 'danger')
    } finally {
      setBusy('')
    }
  }

  const activeTasks = tasks.filter((task) => task.status === 'downloading' || task.status === 'queued')
  const resumableTasks = tasks.filter((task) => task.status === 'paused' || task.status === 'failed' || task.status === 'cancelled')
  const completedTasks = tasks.filter((task) => task.status === 'completed')
  const visibleTasks = tasks.filter((task) => filter === 'active'
    ? task.status === 'downloading' || task.status === 'queued' || task.status === 'paused'
    : filter === 'completed' ? task.status === 'completed' : task.status === 'failed' || task.status === 'cancelled')
  const totalSpeed = activeTasks.reduce((sum, task) => sum + (speeds[task.id] ?? 0), 0)
  const totalRemaining = activeTasks.reduce((sum, task) => sum + Math.max(0, expectedBytes(task) - task.downloadedBytes), 0)
  const cachedBytes = tasks.reduce((sum, task) => sum + Math.max(0, task.downloadedBytes), 0)
  const totalRemainingText = totalSpeed > 0 && activeTasks.every((task) => expectedBytes(task) > 0)
    ? formatDuration(totalRemaining / totalSpeed)
    : activeTasks.length ? translate('计算中') : '—'

  const deleteSelected = async (): Promise<void> => {
    if (!selectedIds.length) return
    setBusy('batch')
    try {
      for (const id of selectedIds) await window.api.offline.delete(id)
      setSelectedIds([])
      await refresh()
      notify(`已删除 ${selectedIds.length} 项缓存`, 'success')
    } catch (error) {
      notify((error as Error).message, 'danger')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="page page-downloads">
      <div className="page-head">
        <div>
          <h1 className="page-title">{translate("离线缓存")}</h1>
          <div className="page-sub">{translate("缓存文件保存在本机数据目录，可在断网时播放")}</div>
        </div>
        <div className="download-toolbar">
          <span className="download-total-speed">{translate("已缓存 ")}{formatBytes(cachedBytes)}{translate(" · 总速度 ")}{formatBytes(totalSpeed)}{translate("/秒 · 剩余 ")}{totalRemainingText}</span>
          {editing ? (
            <>
              <button type="button" className="btn btn-sm" onClick={() => setSelectedIds(visibleTasks.map((task) => task.id))}>{translate("全选")}</button>
              <button type="button" className="btn btn-sm" disabled={!activeTasks.length || busy !== ''} onClick={() => void runAction('batch', () => Promise.all(activeTasks.map((task) => window.api.offline.pause(task.id))), translate('所有下载已暂停'))}>{translate("\n                全部暂停\n              ")}</button>
              <button type="button" className="btn btn-sm" disabled={!resumableTasks.length || busy !== ''} onClick={() => void runAction('batch', () => Promise.all(resumableTasks.map((task) => window.api.offline.retry(task.id))), translate('已开始全部可继续任务'))}>{translate("\n                全部开始\n              ")}</button>
              <button type="button" className="btn btn-sm btn-danger" disabled={!selectedIds.length || busy !== ''} onClick={() => void deleteSelected()}>
                <Icon name="trash" size={13} />{translate(" 删除已选 ")}{selectedIds.length ? `(${selectedIds.length})` : ''}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => { setEditing(false); setSelectedIds([]) }}>{translate("完成")}</button>
            </>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)} disabled={!tasks.length}>{translate("编辑")}</button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            <Icon name="refresh" size={14} />{translate(" 刷新\n          ")}</button>
        </div>
      </div>

      {loading ? (
        <div className="detail-loading"><span className="spin" />{translate(" 正在读取缓存任务…")}</div>
      ) : tasks.length ? (
        <>
        <div className="download-tabs" role="tablist" aria-label={translate("缓存状态")}>
          <button type="button" role="tab" aria-selected={filter === 'active'} className={filter === 'active' ? 'active' : ''} onClick={() => setFilter('active')}>{translate("\n            正在下载 ")}<span>{tasks.filter((task) => task.status === 'downloading' || task.status === 'queued' || task.status === 'paused').length}</span>
          </button>
          <button type="button" role="tab" aria-selected={filter === 'completed'} className={filter === 'completed' ? 'active' : ''} onClick={() => setFilter('completed')}>{translate("\n            已完成 ")}<span>{completedTasks.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={filter === 'other'} className={filter === 'other' ? 'active' : ''} onClick={() => setFilter('other')}>{translate("\n            失败 / 已取消 ")}<span>{tasks.length - completedTasks.length - activeTasks.length - tasks.filter((task) => task.status === 'paused').length}</span>
          </button>
        </div>
        {visibleTasks.length ? (
        <div className="download-list">
          {visibleTasks.map((task) => (
            <article className={`download-row${selectedIds.includes(task.id) ? ' selected' : ''}`} key={task.id}>
              {editing ? (
                <input type="checkbox" className="download-select" aria-label={`选择 ${task.movieName} ${task.episodeName}`} checked={selectedIds.includes(task.id)}
                  onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, task.id] : current.filter((id) => id !== task.id))} />
              ) : null}
              <div className="download-main">
                <div className="download-title">{task.movieName}</div>
                <div className="download-sub">{task.episodeName} <span>·</span> {sourceDisplayLabel(task.siteKey, task.siteName)}</div>
                {task.status === 'downloading' || task.status === 'queued' ? (
                  <div className="download-progress" aria-label={`${task.progress}%`}>
                    <span style={{ width: `${task.progress}%` }} />
                  </div>
                ) : null}
                <div className="download-meta">
                  <span>{statusText(task)}</span>
                  {task.status === 'completed' ? <span>{formatBytes(task.downloadedBytes)}</span> : null}
                  {task.status === 'downloading' || task.status === 'queued' ? <span>{task.progress}% · {formatBytes(task.downloadedBytes)} / {formatTaskTotal(task)}</span> : null}
                  {task.status === 'downloading' ? <span>{formatBytes(speeds[task.id] ?? 0)}{translate("/秒 · 剩余 ")}{expectedBytes(task) >= task.downloadedBytes && (speeds[task.id] ?? 0) > 0 ? formatDuration((expectedBytes(task) - task.downloadedBytes) / (speeds[task.id] ?? 1)) : '计算中'}</span> : null}
                  {task.error ? <span className={task.status === 'failed' ? 'download-error' : ''}>{translate('任务未完成')}</span> : null}
                </div>
              </div>
              {!editing ? <div className="download-actions">
                {task.status === 'completed' ? (
                  <Link className="btn btn-sm btn-primary" to={`/offline/${task.id}`} title={translate("播放离线文件")}>
                    <Icon name="play" size={13} />{translate(" 播放\n                  ")}</Link>
                ) : task.status === 'downloading' || task.status === 'queued' ? (
                  <>
                    <button type="button" className="btn btn-sm" disabled={busy === task.id} onClick={() => void runAction(task.id, () => window.api.offline.pause(task.id), translate('缓存已暂停'))}>{translate("\n                      暂停\n                    ")}</button>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={busy === task.id} onClick={() => void runAction(task.id, () => window.api.offline.cancel(task.id), translate('缓存任务已取消'))}>{translate("\n                      取消\n                    ")}</button>
                  </>
                ) : (
                  <button type="button" className="btn btn-sm" disabled={busy === task.id} onClick={() => void runAction(task.id, () => window.api.offline.retry(task.id), '已继续缓存')}>
                    <Icon name="refresh" size={13} />{translate(" 继续\n                  ")}</button>
                )}
                <button type="button" className="btn btn-sm btn-ghost" title={translate("删除缓存任务")} disabled={busy === task.id} onClick={() => void runAction(task.id, () => window.api.offline.delete(task.id), '')}>
                  <Icon name="trash" size={13} />
                </button>
              </div> : null}
            </article>
          ))}
        </div>
        ) : <div className="download-filter-empty">{translate("此分类暂无任务")}</div>}
        </>
      ) : (
        <EmptyState
          icon={<Icon name="download" size={26} />}
          title={translate("还没有离线缓存")}
          desc={translate('播放剧集时点击缓存按钮，完成后可在这里离线观看。')}
        />
      )}
    </div>
  )
}
