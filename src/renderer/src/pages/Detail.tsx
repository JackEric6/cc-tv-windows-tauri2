import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/icons'
import { Poster } from '@/components/Poster'
import { detailKey, useApp } from '@/store/useApp'
import { pickPlayableLine } from '@/utils/media'
import { translate } from '@/i18n'

export function Detail(): JSX.Element {
  const { siteKey = '', vodId = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const routeState = location.state as { returnTo?: unknown } | null
  const returnTo = typeof routeState?.returnTo === 'string' && routeState.returnTo.startsWith('/') && !routeState.returnTo.startsWith('//')
    ? routeState.returnTo
    : undefined
  const detail = useApp((state) => state.details[detailKey(siteKey, vodId)])
  const site = useApp((state) => state.sites.find((item) => item.key === siteKey))
  const loadDetail = useApp((state) => state.loadDetail)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lineIndex, setLineIndex] = useState(0)
  const detailPath = `${location.pathname}${location.search}${location.hash}`

  const back = (): void => {
    if (returnTo) navigate(returnTo, { replace: true })
    else navigate(-1)
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    loadDetail(siteKey, vodId)
      .then((value) => {
        if (!alive) return
        setLineIndex(Math.max(0, pickPlayableLine(value.lines)))
        setLoading(false)
      })
      .catch((loadError: Error) => {
        if (!alive) return
        setError(loadError.message)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [siteKey, vodId, loadDetail])

  if (loading && !detail) {
    return (
      <div className="page">
        <div className="detail-head">
          <button type="button" className="btn btn-sm" onClick={back}>
            <Icon name="chevron-left" size={14} />{translate('返回')}
          </button>
          <span className="text-3 fs-12">{site?.name ?? siteKey}</span>
        </div>
        <div className="detail-loading"><span className="spin" />{translate('正在获取影片信息…')}</div>
      </div>
    )
  }

  if (error && !detail) {
    return (
      <div className="page">
        <EmptyState
          icon={<Icon name="alert" size={26} />}
          title={translate('获取详情失败')}
          desc={error}
          actions={<button type="button" className="btn" onClick={back}>{translate('返回')}</button>}
        />
      </div>
    )
  }

  if (!detail) return <div className="page" />

  return (
    <div className="page">
      <div className="detail-head">
        <button type="button" className="btn btn-sm" onClick={back}>
          <Icon name="chevron-left" size={14} />{translate('返回')}
        </button>
        <span className="text-3 fs-12">{detail.siteName}{site?.sourceName ? ` · ${site.sourceName}` : ''}</span>
      </div>
      <div className="detail-hero">
        <Poster src={detail.vod_pic} name={detail.vod_name} className="poster-detail" />
        <div className="detail-info">
          <h1 className="detail-title">{detail.vod_name}</h1>
          {detail.lines.length ? (
            <Link
              className="btn btn-primary"
              to={`/play/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}/${lineIndex}/0`}
              state={{ playbackReturnTo: detailPath }}
            >
              <Icon name="play" size={15} />{translate('立即播放')}
            </Link>
          ) : (
            <div className="banner banner-warn">{translate('这个站点没有返回可播放的剧集地址，换一个来源试试。')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
