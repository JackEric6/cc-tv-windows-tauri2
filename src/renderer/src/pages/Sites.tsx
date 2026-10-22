import { useMemo, useState } from 'react'
import type { Site, SiteType } from '@shared/types'
import { SITE_TYPE_LABEL, SITE_TYPE_TAG } from '@shared/siteLabels'
import { Switch } from '@/components/Switch'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/icons'
import { OrdinalLabel } from '@/components/OrdinalLabel'
import { useApp } from '@/store/useApp'
import { translate } from '@/i18n'
import { circledOrdinal } from '@shared/searchSourcePolicy'

const TYPE_ORDER: SiteType[] = [3, 4, 1, 0, 2]

export function Sites(): JSX.Element {
  const sites = useApp((s) => s.sites)
  const setSiteEnabled = useApp((s) => s.setSiteEnabled)
  const setSiteAreaEnabled = useApp((s) => s.setSiteAreaEnabled)
  const setSitesEnabled = useApp((s) => s.setSitesEnabled)
  const refreshSites = useApp((s) => s.refreshSites)
  const notify = useApp((s) => s.notify)

  const [kw, setKw] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | SiteType>('all')
  const [onlyEnabled, setOnlyEnabled] = useState(false)
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [health, setHealth] = useState<Record<string, { ok: boolean; text: string }>>({})

  async function updateSiteEnabled(site: Site, enabled: boolean): Promise<void> {
    try {
      await setSiteEnabled(site.key, enabled)
    } catch (err) {
      notify(`${translate('接口')}${circledOrdinal(sites.findIndex((item) => item.key === site.key) + 1)} 设置失败`, 'danger')
      await refreshSites().catch(() => undefined)
    }
  }

  async function updateSiteAreaEnabled(
    site: Site,
    area: 'home' | 'search' | 'category',
    enabled: boolean
  ): Promise<void> {
    try {
      await setSiteAreaEnabled(site.key, area, enabled)
    } catch (err) {
      notify(`${translate('接口')}${circledOrdinal(sites.findIndex((item) => item.key === site.key) + 1)} 设置失败`, 'danger')
      await refreshSites().catch(() => undefined)
    }
  }

  const typeCounts = useMemo(() => {
    const map = new Map<SiteType, number>()
    for (const s of sites) map.set(s.type, (map.get(s.type) ?? 0) + 1)
    return map
  }, [sites])

  const filtered = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return sites.filter((s) => {
      if (typeFilter !== 'all' && s.type !== typeFilter) return false
      if (onlyEnabled && !s.enabled) return false
      if (!k) return true
      return (
        `${translate('接口')}${circledOrdinal(sites.findIndex((item) => item.key === s.key) + 1)}`.includes(k)
      )
    })
  }, [sites, kw, typeFilter, onlyEnabled])

  async function test(site: Site): Promise<void> {
    setTesting((t) => ({ ...t, [site.key]: true }))
    try {
      const result = await window.api.sites.test(site.key)
      setHealth((h) => ({
        ...h,
        [site.key]: { ok: result.ok, text: result.ok ? `${result.ms}ms` : translate('测试失败') }
      }))
      if (!result.ok) notify(`${translate('接口')}${circledOrdinal(sites.findIndex((item) => item.key === site.key) + 1)}：${translate('测试失败')}`, 'warn')
    } finally {
      setTesting((t) => {
        const next = { ...t }
        delete next[site.key]
        return next
      })
    }
  }

  async function testAllVisible(): Promise<void> {
    const targets = filtered.filter((s) => !s.unsupported && s.enabled)
    for (const site of targets) await test(site)
    notify(`已测试 ${targets.length} 个站点`, 'success')
  }

  const enabledKeys = filtered.filter((s) => s.enabled).map((s) => s.key)

  if (!sites.length) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-title">{translate("影视源")}</div>
          <div className="page-sub">{translate("控制站点总启用状态，并分别设置首页、搜索和分类浏览是否使用该源。")}</div>
          </div>
        </div>
        <EmptyState
          icon={<Icon name="layers" size={26} />}
          title={translate("还没有任何影视源")}
          desc={translate('影视源来自你添加的 JSON 配置。到「设置」里添加一个订阅地址或本地配置文件，这里就会列出全部站点。')}
        />
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">{translate("影视源")}</div>
          <div className="page-sub">{translate("\n            共 ")}{sites.length}{translate(" 个站点 · 启用 ")}{sites.filter((s) => s.enabled).length}{translate(" 个 ·\n            当前列表 ")}{filtered.length}{translate(" 个。总开关停用后，该源不会参与任何区域。\n          ")}</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-sm" onClick={() => void refreshSites()}>
            <Icon name="refresh" size={14} />{translate(" 刷新列表\n          ")}</button>
          <button type="button" className="btn btn-sm" onClick={() => void testAllVisible()}>
            <Icon name="check" size={14} />{translate(" 测试当前列表\n          ")}</button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void setSitesEnabled(enabledKeys, false)}
            disabled={!enabledKeys.length}
          >{translate("\n            全部禁用\n          ")}</button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="search-box" style={{ width: 260 }}>
          <span className="search-icon">
            <Icon name="search" size={15} />
          </span>
          <input value={kw} placeholder={translate("按序号筛选")} onChange={(e) => setKw(e.target.value)} />
        </div>

        <div className="chips">
          <button
            type="button"
            className={`chip${typeFilter === 'all' ? ' active' : ''}`}
            onClick={() => setTypeFilter('all')}
          >{translate("\n            全部类型 ")}<span className="chip-count">{sites.length}</span>
          </button>
          {TYPE_ORDER.filter((t) => typeCounts.has(t)).map((t) => (
            <button
              key={t}
              type="button"
              className={`chip${typeFilter === t ? ' active' : ''}`}
              onClick={() => setTypeFilter(t)}
            >
              {translate(SITE_TYPE_LABEL[t])} <span className="chip-count">{typeCounts.get(t)}</span>
            </button>
          ))}
        </div>

        <div className="grow" />

        <button
          type="button"
          className={`chip${onlyEnabled ? ' active' : ''}`}
          onClick={() => setOnlyEnabled((v) => !v)}
        >{translate("\n          只看已启用\n        ")}</button>
      </div>

      <div className="panel">
        <div className="list">
          {filtered.map((site) => {
            const h = health[site.key]
            const ordinal = `${translate('接口')}${circledOrdinal(sites.findIndex((item) => item.key === site.key) + 1)}`
            return (
              <div className="list-row" key={site.key}>
                <Switch
                  checked={site.enabled}
                  disabled={Boolean(site.unsupported)}
                  onChange={(v) => void updateSiteEnabled(site, v)}
                  title={translate(site.unsupported ?? '启用 / 停用该站点')}
                />

                <div className="list-row-main">
                  <div className="list-row-title site-name">
                    <OrdinalLabel prefix="接口" value={circledOrdinal(sites.findIndex((item) => item.key === site.key) + 1)} />
                    <span className={`tag ${SITE_TYPE_TAG[site.type]}`}>{translate(SITE_TYPE_LABEL[site.type])}</span>
                    {site.searchable ? <span className="tag tag-outline">{translate("可搜索")}</span> : null}
                    {!site.searchable && !site.unsupported ? (
                      <span className="tag tag-outline">{translate("仅浏览")}</span>
                    ) : null}
                  </div>
                  <div className="list-row-sub">
                    {site.unsupported ? (
                      <span style={{ color: 'var(--warn)' }}>{translate('暂不可用')}</span>
                    ) : (
                      <span className="mono">{translate('接口已配置')}</span>
                    )}
                  </div>
                </div>

                {h ? (
                  <span className="health">
                    <span className={`dot ${h.ok ? 'ok' : 'bad'}`} />
                    {h.text.length > 26 ? `${h.text.slice(0, 26)}…` : h.text}
                  </span>
                ) : typeof site.health === 'number' ? (
                  <span className="health">
                    <span className={`dot ${site.health >= 0 ? 'ok' : 'bad'}`} />
                    {site.health >= 0 ? `${site.health}ms` : translate('失败')}
                  </span>
                ) : (
                  <span className="health">{translate("未测试")}</span>
                )}

                <div className="list-row-actions">
                  <div className="site-area-toggles" aria-label={`${ordinal}的区域开关`}>
                    <label title={translate("控制该站点是否显示在首页片单中")}>
                      <span>{translate("首页")}</span>
                      <Switch checked={site.homeEnabled} onChange={(value) => void updateSiteAreaEnabled(site, 'home', value)} />
                    </label>
                    <label title={translate("控制该站点是否参与聚合搜索")}>
                      <span>{translate("搜索")}</span>
                      <Switch checked={site.searchEnabled} onChange={(value) => void updateSiteAreaEnabled(site, 'search', value)} />
                    </label>
                    <label title={translate("控制该站点是否参与分类浏览")}>
                      <span>{translate("分类")}</span>
                      <Switch checked={site.categoryEnabled} onChange={(value) => void updateSiteAreaEnabled(site, 'category', value)} />
                    </label>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={Boolean(testing[site.key]) || Boolean(site.unsupported)}
                    onClick={() => void test(site)}
                  >
                    {testing[site.key] ? <span className="spin" /> : null}{translate(" 测试\n                  ")}</button>
                </div>
              </div>
            )
          })}

          {!filtered.length ? (
            <EmptyState icon={<Icon name="search" size={26} />} title={translate("没有匹配的站点")} desc={translate('换个关键词或清空筛选条件试试。')} />
          ) : null}
        </div>
      </div>
    </div>
  )
}
