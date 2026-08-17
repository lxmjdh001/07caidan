import { useCallback, useMemo, useState } from 'react'
import { ApiClient, type Conversation, type Me } from './api'
import { Login } from './components/Login'
import { ConversationList } from './components/ConversationList'
import { ChatView } from './components/ChatView'
import { AnalysisPanel } from './components/AnalysisPanel'
import { UsersView } from './components/UsersView'
import { AnnouncementsView } from './components/AnnouncementsView'
import { BillingView } from './components/BillingView'
import { CampaignsView } from './components/CampaignsView'
import { SupportView } from './components/SupportView'
import { LogsView } from './components/LogsView'
import { brand } from './branding'
import { LOCALES, useI18n, type Locale } from './i18n'

export function App(): React.JSX.Element {
  const { t, locale, setLocale } = useI18n()
  const [client, setClient] = useState<ApiClient | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [view, setView] = useState<'chats' | 'campaigns' | 'billing' | 'announcements' | 'support' | 'logs' | 'users'>('chats')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const onLogin = useCallback(async (c: ApiClient, _url: string, user: Me) => {
    setClient(c)
    setMe(user)
    if (user.permissions.includes('conversations:read')) {
      try {
        const { conversations } = await c.listConversations(200)
        setConversations(conversations)
      } catch {
        /* 忽略 */
      }
    } else {
      // 没有会话权限就落到第一个有权限的页面，否则登录后是一片空白
      setView(user.permissions.includes('campaigns:manage') ? 'campaigns' : 'users')
    }
  }, [])

  const logout = useCallback(() => {
    void client?.logout().catch(() => {})
    localStorage.removeItem('omni_token')
    setClient(null)
    setMe(null)
    setConversations([])
    setActiveId(null)
    setView('chats')
  }, [client])

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  )

  if (!client || !me) return <Login onLogin={onLogin} />

  const canChats = me.permissions.includes('conversations:read')
  const canUsers = me.permissions.includes('users:manage')
  const canCampaigns = me.permissions.includes('campaigns:manage')
  const canBilling = me.permissions.includes('billing:manage')
  const canAnnounce = me.permissions.includes('announcements:manage')
  const canSupport = me.permissions.includes('support:manage')

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo">{brand.logoText}</span>
          <span className="sidebar-title">{t('app.title')}</span>
        </div>
        <nav className="sidebar-nav">
          {canChats && (
            <button className={view === 'chats' ? 'on' : ''} onClick={() => setView('chats')}>
              <ChatIcon />
              {t('nav.chats')}
            </button>
          )}
          {canCampaigns && (
            <button
              className={view === 'campaigns' ? 'on' : ''}
              onClick={() => setView('campaigns')}
            >
              <ChartIcon />
              {t('nav.campaigns')}
            </button>
          )}
          {canBilling && (
            <button className={view === 'billing' ? 'on' : ''} onClick={() => setView('billing')}>
              <CardIcon />
              {t('nav.billing')}
            </button>
          )}
          {canAnnounce && (
            <button
              className={view === 'announcements' ? 'on' : ''}
              onClick={() => setView('announcements')}
            >
              <BellIcon />
              {t('nav.announcements')}
            </button>
          )}
          {canSupport && (
            <button className={view === 'support' ? 'on' : ''} onClick={() => setView('support')}>
              <LifebuoyIcon />
              {t('nav.support')}
            </button>
          )}
          {canSupport && (
            <button className={view === 'logs' ? 'on' : ''} onClick={() => setView('logs')}>
              <ScrollIcon />
              {t('nav.logs')}
            </button>
          )}
          {canUsers && (
            <button className={view === 'users' ? 'on' : ''} onClick={() => setView('users')}>
              <UsersIcon />
              {t('nav.users')}
            </button>
          )}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-user">
          <div className="su-name">{me.username}</div>
          <div className="su-role">{roleLabel(me.role, t)}</div>
          <select
            className="su-locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            title={t('common.language')}
          >
            {LOCALES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.nativeName}
              </option>
            ))}
          </select>
          <button className="su-logout" onClick={logout}>
            {t('nav.logout')}
          </button>
        </div>
      </aside>

      <main className="main">
        {view === 'users' && canUsers ? (
          <UsersView client={client} currentUser={me.username} />
        ) : view === 'campaigns' && canCampaigns ? (
          <CampaignsView client={client} />
        ) : view === 'billing' && canBilling ? (
          <BillingView client={client} />
        ) : view === 'announcements' && canAnnounce ? (
          <AnnouncementsView client={client} />
        ) : view === 'support' && canSupport ? (
          <SupportView client={client} />
        ) : view === 'logs' && canSupport ? (
          <LogsView client={client} />
        ) : (
          <div className="body">
            <ConversationList
              conversations={conversations}
              activeId={activeId}
              onSelect={setActiveId}
            />
            <ChatView client={client} conversation={active} />
            {active && (
              <AnalysisPanel
                client={client}
                conversation={active}
                canAnalyze={me.permissions.includes('analyze:run')}
              />
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function ChatIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.8-.8L3 20l1.1-5A8 8 0 0 1 3.5 11.5 8.4 8.4 0 0 1 12 3.2a8.4 8.4 0 0 1 9 8.3Z" />
    </svg>
  )
}
/** 角色名走字典；后端返回的是稳定 key，未知角色原样显示 */
function roleLabel(role: string, t: ReturnType<typeof useI18n>['t']): string {
  const known = ['owner', 'admin', 'agent', 'viewer']
  return known.includes(role) ? t(`role.${role}` as 'role.owner') : role
}

function LifebuoyIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <path d="M4.9 4.9 9 9M15 15l4.1 4.1M19.1 4.9 15 9M9 15l-4.1 4.1" />
    </svg>
  )
}
function ScrollIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M8 21h12a2 2 0 0 0 2-2v-1H10v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2h4" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M11 8h5M11 12h5" />
    </svg>
  )
}
function BellIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  )
}
function CardIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </svg>
  )
}
function ChartIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M3 3v18h18" />
      <path d="M7 15l4-5 3 3 5-7" />
    </svg>
  )
}
function UsersIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}
