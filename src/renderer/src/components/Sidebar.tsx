import { NavLink, useLocation } from 'react-router-dom'
import { useApp } from '@/store/useApp'
import { Icon, type IconName } from './icons'
import { translate } from '@/i18n'

interface NavDef {
  to: string
  label: string
  icon: IconName
  libraryTab?: 'favorites' | 'history'
}

export function Sidebar(): JSX.Element {
  const collapsed = useApp((s) => s.settings?.sidebarCollapsed ?? false)
  const favorites = useApp((s) => s.favorites)
  const history = useApp((s) => s.history)
  const updateSettings = useApp((s) => s.updateSettings)
  const location = useLocation()

  const requestedLibraryTab = new URLSearchParams(location.search).get('tab')
  const activeLibraryTab = requestedLibraryTab === 'history' || (!requestedLibraryTab && !favorites.length && history.length)
    ? 'history'
    : 'favorites'

  const nav: NavDef[] = [
    { to: '/', label: '首页', icon: 'home' },
    { to: '/search', label: '分类', icon: 'grid' },
    { to: '/library?tab=history', label: '历史', icon: 'clock', libraryTab: 'history' },
    { to: '/library?tab=favorites', label: '收藏', icon: 'star', libraryTab: 'favorites' },
    { to: '/downloads', label: '下载', icon: 'download' },
    { to: '/sites', label: '接口', icon: 'layers' },
    { to: '/settings', label: '设置', icon: 'settings' }
  ]

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-brand">
        <div className="sidebar-logo" role="img" aria-label={translate("丛丛影视")}>CC</div>
      </div>

      <nav className="sidebar-nav">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => {
              const active = item.libraryTab
                ? location.pathname === '/library' && activeLibraryTab === item.libraryTab
                : isActive
              return `nav-item${active ? ' active' : ''}`
            }}
            title={translate(item.label)}
          >
            <span className="nav-icon">
              <Icon name={item.icon} />
            </span>
            <span className="nav-label">{translate(item.label)}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button
          type="button"
          className="nav-item"
          title={translate(collapsed ? '展开侧栏' : '收起侧栏')}
          onClick={() => void updateSettings({ sidebarCollapsed: !collapsed })}
        >
          <span className="nav-icon">
            <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} />
          </span>
          <span className="nav-label">{translate(collapsed ? '展开侧栏' : '收起侧栏')}</span>
        </button>
      </div>
    </aside>
  )
}
