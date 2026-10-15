import { Link, useLocation } from 'react-router-dom'
import type { Vod } from '@shared/types'
import { Poster } from '@/components/Poster'

/**
 * 一张影片卡。搜索结果和首页内容位共用。
 *
 * 首页内容位给的是各站自己的原始列表（没有做跨站同名合并），所以这里
 * `alternatives` / `allSiteKeys` 都是可选的——没有就不显示「N 个源」那个标签。
 */
export function VodCard({
  vod
}: {
  vod: Vod & { alternatives?: Vod[]; allSiteKeys?: string[]; posterFallbacks?: string[] }
}): JSX.Element {
  const location = useLocation()
  const returnTo = `${location.pathname}${location.search}`
  const sources = [vod, ...(vod.alternatives ?? [])].filter(
    (source, index, all) => all.findIndex((item) => item.siteKey === source.siteKey) === index
  )
  return (
    <div className="vod-card">
      <Link
        className="vod-card-main"
        to={`/detail/${encodeURIComponent(vod.siteKey)}/${encodeURIComponent(vod.vod_id)}`}
        state={{ returnTo }}
      >
        <Poster src={vod.vod_pic} fallbacks={[
          ...(vod.posterFallbacks ?? []),
          ...(vod.alternatives ?? []).map((item) => item.vod_pic)
        ]} name={vod.vod_name} />
        <div className="vod-card-body">
          <div className="vod-card-title" title={vod.vod_name}>
            {vod.vod_name}
          </div>
          <div className="vod-card-meta">
            {vod.vod_remarks ? <span className="vod-card-remarks">{vod.vod_remarks}</span> : null}
            {vod.vod_score && Number(vod.vod_score) > 0 ? (
              <span className="vod-card-score">{vod.vod_score}</span>
            ) : null}
          </div>
        </div>
      </Link>
      <div className="vod-card-footer">
        {sources.map((source) => (
          <Link
            key={`${source.siteKey}-${source.vod_id}`}
            className="tag tag-outline vod-card-source"
            title={`打开「${source.siteName}」详情`}
            to={`/detail/${encodeURIComponent(source.siteKey)}/${encodeURIComponent(source.vod_id)}`}
            state={{ returnTo }}
          >
            {source.siteName}
          </Link>
        ))}
      </div>
    </div>
  )
}
