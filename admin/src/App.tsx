import { useCallback, useMemo, useState } from 'react'
import { ApiClient, type Conversation } from './api'
import { Login } from './components/Login'
import { ConversationList } from './components/ConversationList'
import { ChatView } from './components/ChatView'
import { AnalysisPanel } from './components/AnalysisPanel'

export function App(): React.JSX.Element {
  const [client, setClient] = useState<ApiClient | null>(null)
  const [base, setBase] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const onLogin = useCallback((c: ApiClient, url: string, convs: Conversation[]) => {
    setClient(c)
    setBase(url)
    setConversations(convs)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('omni_token')
    setClient(null)
    setConversations([])
    setActiveId(null)
  }, [])

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  )

  if (!client) return <Login onLogin={onLogin} />

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">OC</span>
        <h1>OmniChat 管理后台</h1>
        <div className="spacer" />
        <span className="who">{base}</span>
        <button onClick={logout}>退出</button>
      </header>
      <div className="body">
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          onSelect={setActiveId}
        />
        <ChatView client={client} conversation={active} />
        {active && <AnalysisPanel client={client} conversation={active} />}
      </div>
    </div>
  )
}
