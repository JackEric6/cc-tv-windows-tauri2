import { Link, NavLink } from 'react-router-dom'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/icons'
import { Poster } from '@/components/Poster'
import { useApp } from '@/store/useApp'
import { relativeTime, watchPercent } from '@/utils/format'
import { translate } from '@/i18n'

export function PlaybackHome(): JSX.Element {
  const history = useApp((state) => state.history)

  return (
    <div className="page page-playback">
      {history.length ? (
        <section className="section">
          <div className="section-head">
            <h1 className="section-title">{translate('最近播放')}</h1>
            <div className="section-more">
              <NavLink to="/library?tab=history">{translate('全部记录 →')}</NavLink>
            </div>
          </div>
          <div className="continue-row">
            {history.slice(0, 8).map((group) => {
              const item = group.items[0]
              const to = item.offlineTaskId
                ? `/offline/${item.offlineTaskId}`
                : `/play/${encodeURIComponent(item.siteKey)}/${encodeURIComponent(item.vodId)}/${item.lineIndex}/${item.epIndex}`
              const percent = watchPercent(item)
              return (
                <Link className="continue-card" key={group.key} to={to} state={{ playbackReturnTo: '/play' }}>
                  <div className="continue-poster">
                    <Poster src={item.pic ?? group.pic} name={group.name} />
                    <span className="continue-play"><Icon name="play" size={16} /></span>
                  </div>
                  <div className="continue-body">
                    <div className="continue-title truncate" title={group.name}>{group.name}</div>
                    <div className="continue-sub truncate">
                      {item.epName || `第 ${item.epIndex + 1} 集`} · {relativeTime(item.updatedAt)}
                    </div>
                    {percent !== null ? (
                      <div className="continue-bar" title={`${translate('已看 ')}${percent}%`}>
                        <span style={{ width: `${percent}%` }} />
                      </div>
                    ) : null}
                  </div>
                </Link>
              )
            })}
          </div>
        </section>
      ) : (
        <EmptyState
          icon={<Icon name="play" size={26} />}
          title={translate('还没有播放内容')}
          desc={translate('播放过的影片和续播记录会显示在这里。')}
          actions={<Link className="btn btn-primary" to="/search">{translate('开始搜索')}</Link>}
        />
      )}
    </div>
  )
}
