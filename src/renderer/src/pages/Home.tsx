import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import type { HomeSection } from '@shared/types'
import { VodCard } from '@/components/VodCard'
import { useApp } from '@/store/useApp'
import { Icon } from '@/components/icons'
import { translate } from '@/i18n'

export function Home(): JSX.Element {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({})
  const [expandedContent, setExpandedContent] = useState<Record<string, HomeSection>>({})
  const [expandingSections, setExpandingSections] = useState<Record<string, boolean>>({})
  const home = useApp((s) => s.home)
  const homeLoading = useApp((s) => s.homeLoading)
  const homeLoaded = useApp((s) => s.homeLoaded)
  const loadHome = useApp((s) => s.loadHome)
  const notify = useApp((s) => s.notify)

  // 内容位要等站点列表就绪，所以不放进 init() 跟首屏一起等。
  useEffect(() => {
    if (!homeLoaded && !homeLoading) void loadHome()
  }, [homeLoaded, homeLoading, loadHome])

  const toggleSection = async (section: HomeSection): Promise<void> => {
    if (expandedSections[section.key]) {
      setExpandedSections((current) => ({ ...current, [section.key]: false }))
      return
    }
    setExpandedSections((current) => ({ ...current, [section.key]: true }))
    if (expandedContent[section.key] || expandingSections[section.key]) return

    setExpandingSections((current) => ({ ...current, [section.key]: true }))
    try {
      const fullSection = await window.api.home.expand(section.key)
      setExpandedContent((current) => ({ ...current, [section.key]: fullSection }))
    } catch (err) {
      notify(`完整片单加载失败：${(err as Error).message}`, 'danger')
    } finally {
      setExpandingSections((current) => ({ ...current, [section.key]: false }))
    }
  }

  return (
    <div className="page page-home">
      {home.length
        ? <div className="home-sections">{home.map((section) => {
            const displaySection = expandedContent[section.key] ?? section
            return (
              <div className="section" key={section.key}>
                <div className="section-head">
                  <div className="section-title">
                    {section.title}
                    {section.origin === 'default' ? (
                      <span className="tag tag-outline" style={{ marginLeft: 8 }}>{translate("\n                        自动\n                      ")}</span>
                    ) : null}
                  </div>
                  <div className="section-more">
                    {section.error ? (
                      <span className="text-3" title={section.error}>
                        {section.error}
                      </span>
                    ) : (
                      <>
                        <span className="text-3">{displaySection.items.length}{translate(" 条")}</span>
                        {expandingSections[section.key] ? (
                          <span className="text-3">{translate("正在加载完整片单…")}</span>
                        ) : null}
                        {section.items.length > 1 ? (
                          <button
                            type="button"
                            className="home-section-toggle"
                            aria-expanded={Boolean(expandedSections[section.key])}
                            disabled={Boolean(expandingSections[section.key])}
                            onClick={() => void toggleSection(section)}
                          >
                            <Icon name="grid" size={13} />
                            {translate(expandedSections[section.key] ? '收起' : '展开')}
                          </button>
                        ) : null}
                        <NavLink to="/search" style={{ marginLeft: 8 }}>{translate("\n                          去分类浏览 →\n                        ")}</NavLink>
                      </>
                    )}
                  </div>
                </div>
                {displaySection.items.length ? (
                  <div className={`home-row${expandedSections[section.key] ? ' expanded' : ''}`}>
                    {displaySection.items.map((vod) => (
                      <VodCard key={`${vod.siteKey}-${vod.vod_id}`} vod={vod} />
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}</div>
        : null}

      {homeLoading && !home.length ? (
        <div className="section home-loading">
          <div className="section-head">
            <div className="section-title">{translate("正在读取各站点的最近更新…")}</div>
            <div className="section-more">
              <span className="text-3">{translate("第一次会慢一点")}</span>
            </div>
          </div>
          <div className="home-row">
            {Array.from({ length: 6 }, (_, i) => (
              <div className="vod-card" key={i}>
                <span className="skeleton sk-poster" />
                <div className="vod-card-body">
                  <span className="skeleton sk-line" />
                  <span className="skeleton sk-line-short" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

    </div>
  )
}
