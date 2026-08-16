import { useCallback, useMemo, useState } from 'react'
import { ApiClient, type Conversation, type Me } from './api'
import { Login } from './components/Login'
import { ConversationList } from './components/ConversationList'
import { ChatView } from './components/ChatView'
import { AnalysisPanel } from './components/AnalysisPanel'
import { UsersView } from './components/UsersView'

const ROLE_LABEL: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  agent: '客服',
  viewer: '只读'
}

export function App(): React.JSX.Element {
  const [client, setClient] = useState<ApiClient | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [base, setBase] = useState('')
  const [view, setView] = useState<'chats' | 'users'>('chats')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const onLogin = useCallback(async (c: ApiClient, url: string, user: Me) => {
    setClient(c)
    setMe(user)
    setBase(url)
    if (user.permissions.includes('conversations:read')) {
      try {
        const { conversations } = await c.listConversations(200)
        setConversations(conversations)
      } catch {
        /* 忽略 */
      }
    } else {
      setView('users')
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

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">OC</span>
        <h1>OmniChat 管理后台</h1>
        <nav className="nav">
          {canChats && (
            <button className={view === 'chats' ? 'on' : ''} onClick={() => setView('chats')}>
              聊天记录
            </button>
          )}
          {canUsers && (
            <button className={view === 'users' ? 'on' : ''} onClick={() => setView('users')}>
              用户管理
            </button>
          )}
        </nav>
        <div className="spacer" />
        <span className="who">
          {me.username} · {ROLE_LABEL[me.role] ?? me.role} · {base}
        </span>
        <button onClick={logout}>退出</button>
      </header>

      {view === 'users' && canUsers ? (
        <UsersView client={client} currentUser={me.username} />
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
    </div>
  )
}
