import { useCallback, useMemo, useState } from 'react'
import { ApiClient, type Conversation, type Me } from './api'
import { Login } from './components/Login'
import { ConversationList } from './components/ConversationList'
import { ChatView } from './components/ChatView'
import { AnalysisPanel } from './components/AnalysisPanel'
import { UsersView } from './components/UsersView'
import { CampaignsView } from './components/CampaignsView'

const ROLE_LABEL: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  agent: '客服',
  viewer: '只读'
}

export function App(): React.JSX.Element {
  const [client, setClient] = useState<ApiClient | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [view, setView] = useState<'chats' | 'campaigns' | 'users'>('chats')
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

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo">OC</span>
          <span className="sidebar-title">管理后台</span>
        </div>
        <nav className="sidebar-nav">
          {canChats && (
            <button className={view === 'chats' ? 'on' : ''} onClick={() => setView('chats')}>
              <ChatIcon />
              聊天记录
            </button>
          )}
          {canCampaigns && (
            <button
              className={view === 'campaigns' ? 'on' : ''}
              onClick={() => setView('campaigns')}
            >
              <ChartIcon />
              引流工单
            </button>
          )}
          {canUsers && (
            <button className={view === 'users' ? 'on' : ''} onClick={() => setView('users')}>
              <UsersIcon />
              用户管理
            </button>
          )}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-user">
          <div className="su-name">{me.username}</div>
          <div className="su-role">{ROLE_LABEL[me.role] ?? me.role}</div>
          <button className="su-logout" onClick={logout}>
            退出登录
          </button>
        </div>
      </aside>

      <main className="main">
        {view === 'users' && canUsers ? (
          <UsersView client={client} currentUser={me.username} />
        ) : view === 'campaigns' && canCampaigns ? (
          <CampaignsView client={client} />
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
