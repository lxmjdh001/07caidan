import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChannelState, Conversation, UnifiedMessage } from '@shared/domain'
import type { AppSettings } from '@shared/settings'
import type { ChannelPluginInfo, OutboundPreview, TranslatorInfo } from '@shared/ipc'
import { AccountList, type AccountRow } from './components/AccountList'
import { AccountModal } from './components/AccountModal'
import { ChannelPicker } from './components/ChannelPicker'
import { ChatView } from './components/ChatView'
import { ConversationList } from './components/ConversationList'
import { QrPanel } from './components/QrPanel'
import { SettingsModal } from './components/SettingsModal'
import { I18nProvider, isLocale, type Locale } from './i18n'

const api = window.omni

export function App({ onLogout }: { onLogout?: () => void }): React.JSX.Element {
  const [channels, setChannels] = useState<Record<string, ChannelState>>({})
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<Record<string, UnifiedMessage[]>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  /** null = 全部消息；否则为 channel key（如 whatsapp:main），只看该账号 */
  const [activeAccountKey, setActiveAccountKey] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [translators, setTranslators] = useState<TranslatorInfo[]>([])
  const [showSettings, setShowSettings] = useState(false)
  /** 打开中的账号设置弹窗（channel key） */
  const [accountModalKey, setAccountModalKey] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<ChannelPluginInfo[]>([])
  const [showPicker, setShowPicker] = useState(false)
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
    void api.listChannelPlugins().then(setPlugins)

    return api.onEvent((evt) => {
      switch (evt.type) {
        case 'channel:state':
          setChannels((prev) => ({
            ...prev,
            [`${evt.state.kind}:${evt.state.accountId}`]: evt.state
          }))
          break
        case 'channel:removed':
          setChannels((prev) => {
            const next = { ...prev }
            delete next[evt.key]
            return next
          })
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
    async (text: string, prepared?: OutboundPreview) => {
      if (!activeId) return
      const msg = await api.sendText(activeId, text, prepared)
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

  const previewOutbound = useCallback(
    async (text: string): Promise<OutboundPreview> => {
      if (!activeId) return { send: text, original: text, targetLang: 'en' }
      return api.previewOutbound(activeId, text)
    },
    [activeId]
  )

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

  const selectAccount = useCallback(
    (key: string | null) => {
      setActiveAccountKey(key)
      // 切换账号视图时，若当前会话不属于该账号则退出会话
      if (key && activeId && !activeId.startsWith(`${key}:`)) setActiveId(null)
    },
    [activeId]
  )

  const addAccountOfKind = useCallback(
    async (kind: string) => {
      setShowPicker(false)
      const key = await api.addAccount(kind)
      setActiveAccountKey(key)
      setActiveId(null)
      // 填凭证类平台：新建后直接打开账号设置让用户填 token
      const plugin = plugins.find((p) => p.kind === kind)
      if (plugin?.authType === 'credentials') setAccountModalKey(key)
    },
    [plugins]
  )

  const locale: Locale = settings && isLocale(settings.locale) ? settings.locale : 'zh-CN'

  // main 账号永远排最前，其余按 key
  const sortKeys = (a: string, b: string): number =>
    a === 'whatsapp:main' ? -1 : b === 'whatsapp:main' ? 1 : a.localeCompare(b)

  /** 账号显示名：备注名 > 登录名 > 序号 */
  const accountLabels = useMemo(() => {
    const keys = Object.keys(channels).sort(sortKeys)
    const labels: Record<string, string> = {}
    keys.forEach((key, i) => {
      labels[key] = settings?.accounts[key]?.label || channels[key]?.selfName || `账号 ${i + 1}`
    })
    return labels
  }, [channels, settings])

  /** 每账号未读聚合 */
  const unreadByAccount = useMemo(() => {
    const map: Record<string, number> = {}
    for (const c of conversations) {
      const key = `${c.channel}:${c.accountId}`
      map[key] = (map[key] ?? 0) + c.unreadCount
    }
    return map
  }, [conversations])

  const accountRows = useMemo<AccountRow[]>(() => {
    return Object.entries(channels)
      .sort(([a], [b]) => sortKeys(a, b))
      .map(([key, state]) => ({
        key,
        label: accountLabels[key] ?? key,
        state,
        unread: unreadByAccount[key] ?? 0
      }))
  }, [channels, accountLabels, unreadByAccount])

  const totalUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + c.unreadCount, 0),
    [conversations]
  )

  const visibleConversations = useMemo(
    () =>
      activeAccountKey
        ? conversations.filter((c) => `${c.channel}:${c.accountId}` === activeAccountKey)
        : conversations,
    [conversations, activeAccountKey]
  )

  /** 当前视图相关的渠道状态（横幅/二维码用） */
  const relevantStates = useMemo(() => {
    if (activeAccountKey) {
      const s = channels[activeAccountKey]
      return s ? [s] : []
    }
    return Object.values(channels)
  }, [channels, activeAccountKey])

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  )

  const activeConvConnected = activeConversation
    ? channels[`${activeConversation.channel}:${activeConversation.accountId}`]?.status ===
      'connected'
    : relevantStates.some((s) => s.status === 'connected')
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
  // 选中具体账号且它在等扫码 → 聊天区显示二维码
  const qrState = activeAccountKey ? channels[activeAccountKey] : undefined
  // 扫码等待、或已生成手机号配对码，都展示登录面板
  const showQr =
    qrState?.status === 'waiting_qr' || qrState?.status === 'waiting_pairing_code'

  return (
    <I18nProvider locale={locale}>
      <div className={`app platform-${api.platform}`}>
        <header className="titlebar">
          <span className="titlebar-title">OmniChat</span>
        </header>
        <div className="app-body">
          <AccountList
            accounts={accountRows}
            totalUnread={totalUnread}
            activeKey={activeAccountKey}
            onSelect={(key) => {
              selectAccount(key)
              if (key) {
                const st = channels[key]
                if (
                  st &&
                  (st.status === 'stopped' || st.status === 'logged_out' || st.status === 'error')
                ) {
                  void api.startChannel(key)
                }
              }
            }}
            onAccountSettings={(key) => setAccountModalKey(key)}
            onAddAccount={() => setShowPicker(true)}
            onOpenSettings={() => setShowSettings(true)}
          />
          <ConversationList
            conversations={visibleConversations}
            activeId={activeId}
            states={relevantStates}
            accountLabels={accountLabels}
            showSourceTags={activeAccountKey === null}
            onSelect={selectConversation}
          />
          <main className="content">
            {showQr ? (
              <QrPanel
                accountKey={activeAccountKey ?? undefined}
                qrDataUrl={qrState?.qrDataUrl}
                pairingCode={qrState?.pairingCode}
              />
            ) : (
              <ChatView
                conversation={activeConversation}
                messages={activeId ? messages[activeId] ?? [] : []}
                connected={activeConvConnected}
                knownFromOther={knownFromOther}
                onSend={sendText}
                onSendMedia={sendMediaFile}
                onSetLang={setConvLang}
                onPreview={previewOutbound}
                confirmBeforeSend={settings?.translation.confirmBeforeSend ?? true}
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
            onAccountLogout={async () => {
              await api.authLogout()
              onLogout?.()
            }}
            onClose={() => setShowSettings(false)}
          />
        )}
        {showPicker && (
          <ChannelPicker
            plugins={plugins}
            onPick={(kind) => void addAccountOfKind(kind)}
            onClose={() => setShowPicker(false)}
          />
        )}
        {accountModalKey && settings && (
          <AccountModal
            accountKey={accountModalKey}
            plugin={plugins.find((p) => p.kind === accountModalKey.split(':')[0])}
            state={channels[accountModalKey]}
            config={settings.accounts[accountModalKey] ?? {}}
            onSave={async (key, config) => {
              await saveSettings({ accounts: { [key]: config } })
            }}
            onLogout={(key) => api.logoutChannel(key)}
            onRemove={async (key) => {
              await api.removeAccount(key)
              const updated = await api.getSettings()
              setSettings(updated)
              if (activeAccountKey === key) setActiveAccountKey(null)
            }}
            onClose={() => setAccountModalKey(null)}
          />
        )}
      </div>
    </I18nProvider>
  )
}
