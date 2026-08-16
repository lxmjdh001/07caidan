import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChannelState, Conversation, UnifiedMessage } from '@shared/domain'
import type { AppSettings } from '@shared/settings'
import type { TranslatorInfo } from '@shared/ipc'
import { ChannelRail } from './components/ChannelRail'
import { ChatView } from './components/ChatView'
import { ConversationList } from './components/ConversationList'
import { QrPanel } from './components/QrPanel'
import { SettingsModal } from './components/SettingsModal'
import { I18nProvider, isLocale, type Locale } from './i18n'

const api = window.omni

export function App(): React.JSX.Element {
  const [channels, setChannels] = useState<Record<string, ChannelState>>({})
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<Record<string, UnifiedMessage[]>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [translators, setTranslators] = useState<TranslatorInfo[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId

  const upsertConversation = useCallback((conv: Conversation) => {
    setConversations((prev) => {
      const rest = prev.filter((c) => c.id !== conv.id)
      return [...rest, conv].sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    })
  }, [])

  useEffect(() => {
    void api.listChannels().then((list) => {
      setChannels(Object.fromEntries(list.map((s) => [`${s.kind}:${s.accountId}`, s])))
    })
    void api.listConversations().then((list) => setConversations(list))
    void api.getSettings().then(setSettings)
    void api.listTranslators().then(setTranslators)

    return api.onEvent((evt) => {
      switch (evt.type) {
        case 'channel:state':
          setChannels((prev) => ({
            ...prev,
            [`${evt.state.kind}:${evt.state.accountId}`]: evt.state
          }))
          break
        case 'conversation:updated':
          upsertConversation(evt.conversation)
          break
        case 'message:updated':
          setMessages((prev) => {
            const list = prev[evt.message.conversationId]
            if (!list) return prev
            return {
              ...prev,
              [evt.message.conversationId]: list.map((m) =>
                m.id === evt.message.id ? evt.message : m
              )
            }
          })
          break
        case 'message:new': {
          const conv = evt.conversation
          const isActive = activeIdRef.current === conv.id
          upsertConversation(isActive ? { ...conv, unreadCount: 0 } : conv)
          if (isActive && conv.unreadCount > 0) void api.markRead(conv.id)
          setMessages((prev) => {
            const list = prev[conv.id]
            // 未加载过的会话不缓存，打开时再整体拉取
            if (!list) return prev
            if (list.some((m) => m.id === evt.message.id)) return prev
            return { ...prev, [conv.id]: [...list, evt.message] }
          })
          break
        }
      }
    })
  }, [upsertConversation])

  const selectConversation = useCallback(
    (id: string) => {
      setActiveId(id)
      setMessages((prev) => (prev[id] ? prev : { ...prev, [id]: [] }))
      void api.listMessages(id).then((list) => {
        setMessages((prev) => ({ ...prev, [id]: list }))
      })
      void api.markRead(id)
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c))
      )
    },
    []
  )

  const sendText = useCallback(
    async (text: string) => {
      if (!activeId) return
      const msg = await api.sendText(activeId, text)
      setMessages((prev) => {
        const list = prev[activeId] ?? []
        if (list.some((m) => m.id === msg.id)) return prev
        return { ...prev, [activeId]: [...list, msg] }
      })
    },
    [activeId]
  )

  const sendMediaFile = useCallback(async () => {
    if (!activeId) return
    const msg = await api.sendMedia(activeId)
    if (!msg) return
    setMessages((prev) => {
      const list = prev[activeId] ?? []
      if (list.some((m) => m.id === msg.id)) return prev
      return { ...prev, [activeId]: [...list, msg] }
    })
  }, [activeId])

  const setConvLang = useCallback(
    async (lang: string | null) => {
      if (activeId) await api.setConversationLang(activeId, lang)
    },
    [activeId]
  )

  const saveSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const updated = await api.updateSettings(patch)
    setSettings(updated)
  }, [])

  const locale: Locale = settings && isLocale(settings.locale) ? settings.locale : 'zh-CN'
  const waState = channels['whatsapp:main']
  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  )
  // 同一客户（contactId 相同）是否在其他账号/渠道出现过
  const knownFromOther = useMemo(() => {
    const c = activeConversation
    if (!c?.contactId) return false
    return conversations.some(
      (other) =>
        other.id !== c.id &&
        other.contactId === c.contactId &&
        (other.accountId !== c.accountId || other.channel !== c.channel)
    )
  }, [conversations, activeConversation])
  const showQr = waState?.status === 'waiting_qr'

  return (
    <I18nProvider locale={locale}>
      <div className={`app platform-${api.platform}`}>
        <header className="titlebar">
          <span className="titlebar-title">OmniChat</span>
        </header>
        <div className="app-body">
          <ChannelRail
          channels={channels}
          onChannelClick={(key) => {
            const st = channels[key]
            if (st && (st.status === 'stopped' || st.status === 'logged_out' || st.status === 'error')) {
              void api.startChannel(key)
            }
          }}
          onOpenSettings={() => setShowSettings(true)}
        />
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          waState={waState}
          onSelect={selectConversation}
        />
          <main className="content">
            {showQr ? (
              <QrPanel qrDataUrl={waState?.qrDataUrl} />
            ) : (
              <ChatView
                conversation={activeConversation}
                messages={activeId ? messages[activeId] ?? [] : []}
                connected={waState?.status === 'connected'}
                knownFromOther={knownFromOther}
                onSend={sendText}
                onSendMedia={sendMediaFile}
                onSetLang={setConvLang}
              />
            )}
          </main>
        </div>
        {showSettings && settings && (
          <SettingsModal
            settings={settings}
            translators={translators}
            onSave={async (patch) => {
              await saveSettings(patch)
              setShowSettings(false)
            }}
            onLogoutWhatsApp={() => api.logoutChannel('whatsapp:main')}
            onClose={() => setShowSettings(false)}
          />
        )}
      </div>
    </I18nProvider>
  )
}
