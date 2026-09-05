import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseConversationId, type ChannelKind, type ChannelState, type Conversation, type UnifiedMessage } from '@shared/domain'
import type { AppSettings } from '@shared/settings'
import type { AccountNetworkState } from '@shared/network'
import type { ChannelPluginInfo, OutboundPreview, TranslatorInfo } from '@shared/ipc'
import { AccountList, type AccountRow } from './components/AccountList'
import { AccountModal } from './components/AccountModal'
import { AccountInheritanceModal } from './components/AccountInheritanceModal'
import { NoticeModal, useNotices } from './components/NoticeModal'
import { BillingPage } from './pages/BillingPage'
import { TeamPage } from './pages/TeamPage'
import { SupportPage } from './pages/SupportPage'
import { CampaignPage } from './pages/CampaignPage'
import { SettingsPage } from './pages/SettingsPage'
import { HomePage } from './pages/HomePage'
import { ManagementPage } from './pages/ManagementPage'
import { ProxyPage } from './pages/ProxyPage'
import { QuickMessagesPage } from './pages/QuickMessagesPage'
import { ChannelPicker } from './components/ChannelPicker'
import { ChatView } from './components/ChatView'
import { ConversationList } from './components/ConversationList'
import { QrPanel } from './components/QrPanel'
import { TopToolbar } from './components/TopToolbar'
import { I18nProvider, localeDir, resolveLocale, type Locale, useI18n } from './i18n'
import { shouldShowLoginPanel } from './login-flow'
import type { ThemeMode } from '@shared/settings'
import { Check, LogOut, X } from 'lucide-react'
import './quit-modal.css'

const api = window.omni

function sortConversations(a: Conversation, b: Conversation): number {
  const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
  return pinnedDelta || b.lastMessageAt - a.lastMessageAt
}

function accountPresence(status?: ChannelState['status']): 'online' | 'offline' | 'error' {
  if (status === 'connected') return 'online'
  if (status === 'error') return 'error'
  return 'offline'
}

function supportsGroupManagement(accountKey: string): boolean {
  return accountKey.startsWith('whatsapp:') || accountKey.startsWith('telegram:')
}

type MainView = 'home' | 'chat' | 'campaigns' | 'billing' | 'support' | 'settings' | 'team' | 'management' | 'proxy' | 'quick-messages'

export function App({ onLogout }: { onLogout?: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const [channels, setChannels] = useState<Record<string, ChannelState>>({})
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<Record<string, UnifiedMessage[]>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  /** null = 全部消息；否则为 channel key（如 whatsapp:main），只看该账号 */
  const [activeAccountKey, setActiveAccountKey] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [networks, setNetworks] = useState<Record<string, AccountNetworkState>>({})
  const [translators, setTranslators] = useState<TranslatorInfo[]>([])
  /** 主视图：聊天 / 工单 / 设置。工单与设置做成整页，弹窗里放不下 */
  const [view, setView] = useState<MainView>('home')
  const [viewHistory, setViewHistory] = useState<MainView[]>([])
  const [viewFuture, setViewFuture] = useState<MainView[]>([])
  const [homeRefreshKey, setHomeRefreshKey] = useState(0)
  const [loginZoom, setLoginZoom] = useState(100)
  /**
   * 客户端 RBAC：undefined = 旧后台/未登录（不限制，兼容静态令牌），
   * 数组 = 服务端下发的有效权限。界面按此显隐；真正的强制在服务端。
   */
  const [permissions, setPermissions] = useState<string[] | undefined>(undefined)
  // 套餐账号配额（来自 /api/billing/me）；null = 未知/未取到 → 不拦（fail-open）
  const [accountQuota, setAccountQuota] = useState<number | null>(null)
  /** 打开中的账号设置弹窗（channel key） */
  const [accountModalKey, setAccountModalKey] = useState<string | null>(null)
  const [focusProxyKey, setFocusProxyKey] = useState<string | null>(null)
  const [inheritTargetKey, setInheritTargetKey] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<ChannelPluginInfo[]>([])
  const [showPicker, setShowPicker] = useState(false)
  const [quitConfirmOpen, setQuitConfirmOpen] = useState(false)
  const noticeState = useNotices()
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId

  useEffect(() => {
    if (!quitConfirmOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setQuitConfirmOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [quitConfirmOpen])

  const navigateTo = useCallback((next: MainView) => {
    setView((current) => {
      if (current === next) return current
      setViewHistory((prev) => [...prev, current])
      setViewFuture([])
      return next
    })
  }, [])

  const goBack = useCallback(() => {
    setViewHistory((prev) => {
      const last = prev[prev.length - 1]
      if (!last) return prev
      setViewFuture((future) => [view, ...future])
      setView(last)
      return prev.slice(0, -1)
    })
  }, [view])

  const goForward = useCallback(() => {
    setViewFuture((prev) => {
      const next = prev[0]
      if (!next) return prev
      setViewHistory((history) => [...history, view])
      setView(next)
      return prev.slice(1)
    })
  }, [view])

  const refreshData = useCallback(async () => {
    const [channelList, conversationList, currentSettings, translatorList, pluginList, networkList] = await Promise.all([
      api.listChannels(),
      api.listConversations(),
      api.getSettings(),
      api.listTranslators(),
      api.listChannelPlugins(),
      api.listAccountNetworks()
    ])
    setChannels(Object.fromEntries(channelList.map((s) => [`${s.kind}:${s.accountId}`, s])))
    setConversations(conversationList)
    setSettings(currentSettings)
    setTranslators(translatorList)
    setPlugins(pluginList)
    setNetworks(Object.fromEntries(networkList.map((state) => [state.accountKey, state])))
    setHomeRefreshKey((key) => key + 1)
  }, [])

  const upsertConversation = useCallback((conv: Conversation) => {
    setConversations((prev) => {
      const rest = prev.filter((c) => c.id !== conv.id)
      return [...rest, conv].sort(sortConversations)
    })
  }, [])

  // 拉取套餐账号配额；随视图切换刷新，保证在套餐页改过套餐后账号上限即时更新。
  // 取不到（子账号无 billing、离线等）→ null → 不拦（fail-open）。
  useEffect(() => {
    void api
      .billing<{ accountQuota?: number }>('me')
      .then((m) => setAccountQuota(typeof m.accountQuota === 'number' ? m.accountQuota : null))
      .catch(() => setAccountQuota(null))
  }, [view])

  useEffect(() => {
    // 先用本地缓存的权限秒开界面，再向后台刷新（角色被老板改过时生效）
    void api.authState().then((st) => setPermissions(st.permissions))
    void api.authRefresh().then((st) => {
      setPermissions(st.permissions)
      if (!st.authenticated) onLogout?.()
    })
    void api.listChannels().then((list) => {
      setChannels(Object.fromEntries(list.map((s) => [`${s.kind}:${s.accountId}`, s])))
    })
    void api.listConversations().then((list) => setConversations(list))
    void api.getSettings().then(setSettings)
    void api.listTranslators().then(setTranslators)
    void api.listChannelPlugins().then(setPlugins)
    void api.listAccountNetworks().then((list) => {
      setNetworks(Object.fromEntries(list.map((state) => [state.accountKey, state])))
    })

    return api.onEvent((evt) => {
      switch (evt.type) {
        case 'channel:state':
          setChannels((prev) => ({
            ...prev,
            [`${evt.state.kind}:${evt.state.accountId}`]: evt.state
          }))
          // Kakao 开始认证后主进程会立即清除一次性密码，并在成功后写入会话令牌。
          // 每次状态推进都刷新渲染进程副本，避免账号弹窗继续持有旧密码。
          if (evt.state.kind === 'kakaotalk') {
            void api.getSettings().then(setSettings)
          }
          break
        case 'conversation:open':
          // 点击系统通知跳转过来：切回聊天视图并打开该会话
          navigateTo('chat')
          setActiveAccountKey(null)
          void selectConversation(evt.conversationId)
          break
        case 'channel:removed':
          setChannels((prev) => {
            const next = { ...prev }
            delete next[evt.key]
            return next
          })
          setNetworks((prev) => {
            const next = { ...prev }
            delete next[evt.key]
            return next
          })
          break
        case 'network:state':
          setNetworks((prev) => ({ ...prev, [evt.state.accountKey]: evt.state }))
          break
        case 'conversation:updated':
          upsertConversation(evt.conversation)
          break
        case 'conversation:removed':
          setConversations((prev) => prev.filter((c) => c.id !== evt.conversationId))
          setMessages((prev) => {
            const next = { ...prev }
            delete next[evt.conversationId]
            return next
          })
          if (activeIdRef.current === evt.conversationId) setActiveId(null)
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
  }, [navigateTo, upsertConversation])

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
    async (text: string, prepared?: OutboundPreview): Promise<UnifiedMessage> => {
      if (!activeId) throw new Error('未选择会话')
      const conversationId = activeId
      const { channel, accountId } = parseConversationId(conversationId)
      const optimisticId = crypto.randomUUID()
      const optimistic: UnifiedMessage = {
        id: optimisticId,
        channel,
        accountId,
        conversationId,
        direction: 'out',
        body: { type: 'text', text: prepared?.send ?? text },
        translation: prepared?.engine
          ? { text: prepared.original, targetLang: prepared.targetLang, engine: prepared.engine }
          : undefined,
        timestamp: Date.now(),
        status: 'pending'
      }

      // 先本地回显，网络发送和持久化在后台完成，避免点击后聊天区空等。
      setMessages((prev) => ({
        ...prev,
        [conversationId]: [...(prev[conversationId] ?? []), optimistic]
      }))

      try {
        const msg = await api.sendText(conversationId, text, prepared)
        setMessages((prev) => {
          const list = prev[conversationId] ?? []
          return {
            ...prev,
            [conversationId]: [
              ...list.filter((item) => item.id !== optimisticId && item.id !== msg.id),
              msg
            ]
          }
        })
        return msg
      } catch (error) {
        setMessages((prev) => ({
          ...prev,
          [conversationId]: (prev[conversationId] ?? []).map((item) =>
            item.id === optimisticId ? { ...item, status: 'failed' } : item
          )
        }))
        throw error
      }
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

  const toggleConversationPinned = useCallback(
    async (conversationId: string, pinned: boolean): Promise<void> => {
      const previousPinned =
        conversations.find((conversation) => conversation.id === conversationId)?.pinned ?? false
      setConversations((prev) =>
        prev
          .map((conversation) =>
            conversation.id === conversationId ? { ...conversation, pinned } : conversation
          )
          .sort(sortConversations)
      )
      try {
        await api.setConversationPinned(conversationId, pinned)
      } catch (error) {
        setConversations((prev) =>
          prev
            .map((conversation) =>
              conversation.id === conversationId
                ? { ...conversation, pinned: previousPinned }
                : conversation
            )
            .sort(sortConversations)
        )
        const detail = error instanceof Error ? error.message : String(error)
        window.alert(`设置置顶失败：${detail}`)
      }
    },
    [conversations]
  )

  const toggleConversationMuted = useCallback(async (conversationId: string, muted: boolean): Promise<void> => {
    setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, muted } : c)))
    try {
      await api.setConversationMuted(conversationId, muted)
    } catch (error) {
      window.alert(`设置静音失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  const clearConversation = useCallback(async (conversationId: string): Promise<void> => {
    try {
      await api.clearConversation(conversationId)
      setMessages((prev) => ({ ...prev, [conversationId]: [] }))
      setConversations((prev) => prev.map((c) => c.id === conversationId ? { ...c, unreadCount: 0, lastMessageAt: 0, lastMessagePreview: '' } : c))
    } catch (error) {
      window.alert(`清空聊天失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  const deleteConversation = useCallback(async (conversationId: string): Promise<void> => {
    try {
      await api.deleteConversation(conversationId)
      setConversations((prev) => prev.filter((c) => c.id !== conversationId))
      setMessages((prev) => { const next = { ...prev }; delete next[conversationId]; return next })
      if (activeIdRef.current === conversationId) setActiveId(null)
    } catch (error) {
      window.alert(`删除聊天失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  const inheritAccountConversations = useCallback(async (sourceKey: string, targetKey: string): Promise<{ conversations: number; messages: number }> => {
    const result = await api.inheritAccountConversations(sourceKey, targetKey)
    const updated = await api.listConversations()
    setConversations(updated)
    return result
  }, [])

  const saveSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const updated = await api.updateSettings(patch)
    setSettings(updated)
  }, [])

  /** 删除后以主进程的实际注册表为准刷新，避免事件延迟导致界面残留。 */
  const removeAccount = useCallback(async (key: string): Promise<boolean> => {
    try {
      await api.removeAccount(key)
      const [updated, channelList] = await Promise.all([api.getSettings(), api.listChannels()])
      setSettings(updated)
      setChannels(Object.fromEntries(channelList.map((state) => [`${state.kind}:${state.accountId}`, state])))
      if (activeAccountKey === key) setActiveAccountKey(null)
      if (activeId?.startsWith(`${key}:`)) setActiveId(null)
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      window.alert(`删除账号失败：${detail}`)
      return false
    }
  }, [activeAccountKey, activeId])

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
      // 新账号已写入 settings.accounts（账号注册表），但 stopped 态不发 channel:state 事件，
      // 刷新一次设置让账号数即时反映到配额软门（否则会话内可连加越过上限）。
      const [nextSettings, channelList, networkList] = await Promise.all([
        api.getSettings(),
        api.listChannels(),
        api.listAccountNetworks()
      ])
      setSettings(nextSettings)
      setChannels(Object.fromEntries(channelList.map((state) => [`${state.kind}:${state.accountId}`, state])))
      setNetworks(Object.fromEntries(networkList.map((state) => [state.accountKey, state])))
      setActiveAccountKey(key)
      setActiveId(null)
      // 新增账号只创建独立窗口与设备指纹，不强制打断用户填写代理。
      // 代理由账号右键菜单或聊天区右侧菜单按需打开；真正登录前仍执行网络门禁。
      navigateTo('chat')
    },
    [navigateTo]
  )

  // 未显式设置时按系统语言推断；navigator.language 在 Electron 渲染进程里就是系统语言
  const locale: Locale = resolveLocale(settings?.locale, navigator.language)

  // 主题与书写方向写到根节点：CSS 用 [data-theme] 覆盖令牌，dir 让整体布局镜像
  useEffect(() => {
    const root = document.documentElement
    const theme = settings?.theme ?? 'system'
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    root.lang = locale
    root.dir = localeDir(locale)
  }, [settings?.theme, locale])

  // 各平台账号按 key 稳定排序，不再保留不可删除的固定主账号。
  const sortKeys = (a: string, b: string): number => a.localeCompare(b)

  /** 账号显示名：备注名 > 登录名 > 序号 */
  const accountLabels = useMemo(() => {
    const keys = Object.keys(channels).sort(sortKeys)
    const labels: Record<string, string> = {}
    keys.forEach((key, i) => {
      labels[key] = settings?.accounts[key]?.label || channels[key]?.selfName || `账号 ${i + 1}`
    })
    return labels
  }, [channels, settings])

  /** 工单页需要的账号清单（key / 备注名 / 平台 / accountId） */
  const accountOptions = useMemo(
    () =>
      Object.keys(channels)
        .sort(sortKeys)
        .map((key) => ({
          key,
          label: accountLabels[key] ?? key,
          channel: key.split(':')[0] ?? '',
          accountId: key.split(':').slice(1).join(':'),
          selfHandle: channels[key]?.selfHandle,
          avatarMediaId: channels[key]?.avatarMediaId,
          status: accountPresence(channels[key]?.status)
        })),
    [channels, accountLabels]
  )

  /** 每账号未读聚合 */
  const unreadByAccount = useMemo(() => {
    const map: Record<string, number> = {}
    for (const c of conversations) {
      const key = `${c.channel}:${c.accountId}`
      map[key] = (map[key] ?? 0) + (c.unreadCount || 0)
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
        unread: unreadByAccount[key] ?? 0,
        disabled: settings?.accounts[key]?.disabled === true
      }))
  }, [channels, accountLabels, unreadByAccount, settings])

  const totalUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
    [conversations]
  )

  const toggleAccountEnabled = useCallback(async (key: string, enabled: boolean): Promise<void> => {
    try {
      await api.setAccountEnabled(key, enabled)
      setSettings(await api.getSettings())
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      window.alert(`${enabled ? '启用' : '禁用'}账号失败：${detail}`)
    }
  }, [])

  // 总未读同步到系统角标：客服把窗口切走后也能看到有新客进线
  useEffect(() => {
    void api.setUnreadTotal(totalUnread)
  }, [totalUnread])

  const visibleConversations = useMemo(
    () =>
      activeAccountKey
        ? conversations.filter((c) => `${c.channel}:${c.accountId}` === activeAccountKey)
        : conversations,
    [conversations, activeAccountKey]
  )

  const refreshGroups = useCallback(async (): Promise<void> => {
    if (!activeAccountKey || !supportsGroupManagement(activeAccountKey)) return
    try {
      const listGroups = (api as typeof api & { listGroups?: typeof api.listGroups }).listGroups
      if (!listGroups) {
        window.alert('当前客户端版本未加载群组功能，请完全退出后重新启动客户端')
        return
      }
      const groups = await listGroups(activeAccountKey)
      setConversations((prev) => {
        const incoming = new Map(groups.map((conversation) => [conversation.id, conversation]))
        return [...prev.filter((conversation) => !incoming.has(conversation.id)), ...groups].sort(sortConversations)
      })
    } catch (error) {
      window.alert(`读取群组失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [activeAccountKey])

  const createGroup = useCallback(async (subject: string, participantIds: string[]): Promise<void> => {
    if (!activeAccountKey || !supportsGroupManagement(activeAccountKey)) return
    try {
      const createGroupApi = (api as typeof api & { createGroup?: typeof api.createGroup }).createGroup
      if (!createGroupApi) {
        window.alert('当前客户端版本未加载群组功能，请完全退出后重新启动客户端')
        return
      }
      const group = await createGroupApi(activeAccountKey, subject, participantIds)
      setConversations((prev) => [...prev.filter((conversation) => conversation.id !== group.id), group].sort(sortConversations))
      setActiveId(group.id)
    } catch (error) {
      window.alert(`创建群组失败：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }, [activeAccountKey])

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
  // 选中具体账号且登录尚未完成 → 聊天区持续显示登录面板。
  // Telegram 扫码后还可能要求两步验证密码，不能在二维码消失时切到聊天页。
  const qrState = activeAccountKey ? channels[activeAccountKey] : undefined
  const showQr = shouldShowLoginPanel(qrState?.status)

  const can = (perm: string): boolean =>
    permissions === undefined || permissions.includes(perm)

  // 账号数以账号注册表 settings.accounts 为准（含尚未连接的 stopped 账号，它们也占配额），
  // 而非 channels（stopped 新账号不发事件、会漏计）。settings 未就绪时回落 channels。
  const accountCount = settings
    ? Object.keys(settings.accounts).length
    : Object.keys(channels).length
  // 已达套餐账号配额：有套餐（配额>0）且账号数已达配额时拦。
  // 配额未知(null)或无套餐(0)不拦：新用户加首批账号/未订阅的引导流程不受影响，
  // 本护栏只针对「有套餐的老板超出其套餐账号上限」这一实际问题。
  const atAccountQuota = accountQuota !== null && accountQuota > 0 && accountCount >= accountQuota

  return (
    <I18nProvider locale={locale}>
      <div className={`app platform-${api.platform}`}>
        <TopToolbar
          canBack={viewHistory.length > 0}
          canForward={viewFuture.length > 0}
          theme={settings?.theme ?? 'system'}
          locale={locale}
          zoom={loginZoom}
          onHome={() => {
            setActiveId(null)
            navigateTo('home')
          }}
          onBack={goBack}
          onForward={goForward}
          onRefresh={() => void refreshData()}
          onTheme={(theme: ThemeMode) => void saveSettings({ theme })}
          onLocale={(nextLocale) => void saveSettings({ locale: nextLocale })}
          onZoom={(delta) => setLoginZoom((value) => Math.max(70, Math.min(140, value + delta)))}
          onResetZoom={() => setLoginZoom(100)}
        />
        <div className="app-body">
          <AccountList
            accounts={accountRows}
            totalUnread={totalUnread}
            activeKey={activeAccountKey}
            platformOrder={settings?.platformOrder ?? [
              'whatsapp',
              'telegram',
              'telegram_bot',
              'line',
              'kakaotalk',
              'facebook',
              'instagram',
              'tiktok',
              'x',
              'snapchat'
            ]}
            onPlatformOrderChange={(platformOrder: ChannelKind[]) => void saveSettings({ platformOrder })}
            onSelect={(key) => {
              navigateTo('chat')
              selectAccount(key)
              if (key) {
                const st = channels[key]
                if (
                  st &&
                  settings !== null &&
                  !settings.accounts[key]?.disabled &&
                  (st.status === 'stopped' || st.status === 'logged_out' || st.status === 'error')
                ) {
                  if (settings.accounts[key]?.proxyUrl) {
                    void api.startChannel(key)
                  }
                }
              }
            }}
            onAccountSettings={(key) => { setFocusProxyKey(null); setAccountModalKey(key) }}
            onProxySettings={(key) => { setFocusProxyKey(key); setAccountModalKey(key) }}
            onReconnect={(key) => {
              if (!settings || settings.accounts[key]?.disabled) return
              if (!settings.accounts[key]?.proxyUrl) {
                setFocusProxyKey(key)
                setAccountModalKey(key)
              } else {
                void api.startChannel(key)
              }
            }}
            onToggleEnabled={(key, enabled) => void toggleAccountEnabled(key, enabled)}
            onMarkAccountRead={(key) => {
              const accountConversations = conversations.filter((conversation) => `${conversation.channel}:${conversation.accountId}` === key)
              for (const conversation of accountConversations) void api.markRead(conversation.id)
              setConversations((prev) => prev.map((conversation) => `${conversation.channel}:${conversation.accountId}` === key ? { ...conversation, unreadCount: 0 } : conversation))
            }}
            onLogoutAccount={(key) => {
              if (window.confirm('确定退出这个账号？本地登录凭证将被清除。')) void api.logoutChannel(key)
            }}
            onRemoveAccount={(key) => {
              if (!window.confirm('确定删除这个账号？账号会从列表移除，聊天记录会保留。')) return
              void removeAccount(key)
            }}
            onInheritAccount={(key) => setInheritTargetKey(key)}
            onAddAccount={() => setShowPicker(true)}
            onOpenSettings={() => navigateTo(view === 'settings' ? 'chat' : 'settings')}
            onOpenBilling={() => navigateTo(view === 'billing' ? 'chat' : 'billing')}
            onOpenSupport={() => navigateTo(view === 'support' ? 'chat' : 'support')}
            onOpenManagement={() => navigateTo(view === 'management' ? 'chat' : 'management')}
            onQuitApplication={() => setQuitConfirmOpen(true)}
            activeView={view === 'home' ? 'chat' : view === 'proxy' || view === 'quick-messages' ? 'management' : view}
            showBilling={can('billing:manage')}
            allowAddAccount={can('accounts:manage')}
            atAccountQuota={atAccountQuota}
            allowAccountSettings={can('accounts:manage')}
          />

          {view === 'home' ? (
            <main className="content home-content">
              {settings && (
                <HomePage
                  key={homeRefreshKey}
                  settings={settings}
                  channels={channels}
                  plugins={plugins}
                  onOpenApp={(kind) => {
                    const plugin = plugins.find((candidate) => candidate.kind === kind)
                    const existing = Object.keys(channels).find((key) => key.startsWith(`${kind}:`))
                    if (existing) {
                      setActiveAccountKey(existing)
                      setActiveId(null)
                      navigateTo('chat')
                      const state = channels[existing]
                      if (state && !settings?.accounts[existing]?.disabled && ['stopped', 'logged_out', 'error'].includes(state.status)) {
                        if (!settings.accounts[existing]?.proxyUrl) {
                          return
                        } else if (plugin?.authType === 'oauth') {
                          setAccountModalKey(existing)
                        } else {
                          void api.startChannel(existing)
                        }
                      }
                      return
                    }
                    navigateTo('chat')
                    void addAccountOfKind(kind)
                  }}
                  onOpenManagement={() => navigateTo('management')}
                  onOpenProxy={() => navigateTo('proxy')}
                  onOpenSubaccounts={() => navigateTo('team')}
                  onOpenWorkorders={() => navigateTo('campaigns')}
                  onOpenQuickMessages={() => navigateTo('quick-messages')}
                  canSubaccounts={can('team:manage')}
                  canProxy={can('accounts:manage')}
                  canWorkorders={can('campaigns:manage')}
                  onRefresh={() => void refreshData()}
                />
              )}
            </main>
          ) : view === 'management' ? (
            <ManagementPage
              canSubaccounts={can('team:manage')}
              canProxy={can('accounts:manage')}
              canWorkorders={can('campaigns:manage')}
              onOpenSubaccounts={() => navigateTo('team')}
              onOpenProxy={() => navigateTo('proxy')}
              onOpenWorkorders={() => navigateTo('campaigns')}
              onOpenQuickMessages={() => navigateTo('quick-messages')}
            />
          ) : view === 'proxy' && settings ? (
            <ProxyPage
              settings={settings}
              channels={channels}
              networks={networks}
              onSettings={setSettings}
              onOpenAccount={(key) => {
                setActiveAccountKey(key)
                setActiveId(null)
                navigateTo('chat')
                const plugin = plugins.find((candidate) => candidate.kind === key.split(':')[0])
                if (plugin?.authType === 'credentials' || plugin?.authType === 'oauth') {
                  setFocusProxyKey(null)
                  setAccountModalKey(key)
                }
              }}
            />
          ) : view === 'quick-messages' && settings ? (
            <QuickMessagesPage
              quickReplies={settings.quickReplies}
              onSave={async (quickReplies) => { await saveSettings({ quickReplies }) }}
            />
          ) : view === 'campaigns' ? (
            <CampaignPage accounts={accountOptions} />
          ) : view === 'billing' ? (
            <BillingPage />
          ) : view === 'team' ? (
            <TeamPage />
          ) : view === 'support' ? (
            <SupportPage />
          ) : view === 'settings' && settings ? (
            <SettingsPage
              settings={settings}
              translators={translators}
              canManageSettings={can('settings:manage')}
              onSave={saveSettings}
              onAccountLogout={async () => {
                await api.authLogout()
                onLogout?.()
              }}
            />
          ) : (
            <>
            <ConversationList
                conversations={visibleConversations}
                activeId={activeId}
                states={relevantStates}
                accountLabels={accountLabels}
                showSourceTags={activeAccountKey === null}
                onSelect={selectConversation}
                onTogglePinned={toggleConversationPinned}
                onToggleMuted={toggleConversationMuted}
                onClearChat={clearConversation}
                onDeleteChat={deleteConversation}
                onMarkAllRead={() => {
                  for (const conversation of conversations) void api.markRead(conversation.id)
                  setConversations((prev) => prev.map((conversation) => ({ ...conversation, unreadCount: 0 })))
                }}
                accountKey={activeAccountKey}
                onRefreshGroups={refreshGroups}
                onCreateGroup={createGroup}
              />
              <main className="content">
                {showQr ? (
                  <div className="login-zoom-layer" style={{ transform: `scale(${loginZoom / 100})` }}>
                    <QrPanel
                      accountKey={activeAccountKey ?? undefined}
                      qrDataUrl={qrState?.qrDataUrl}
                      pairingCode={qrState?.pairingCode}
                      kind={qrState?.kind}
                      verificationCode={qrState?.verificationCode}
                      status={qrState?.status}
                      detail={qrState?.detail}
                    />
                  </div>
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
                    quickReplies={settings?.quickReplies ?? []}
                    onManageQuickReplies={() => navigateTo('quick-messages')}
                    onOpenProxySettings={(key) => { setFocusProxyKey(key); setAccountModalKey(key) }}
                  />
                )}
              </main>
            </>
          )}
        </div>
        <NoticeModal
          announcements={noticeState.announcements}
          notices={noticeState.notices}
          onClose={noticeState.dismiss}
        />
        {showPicker && (
          <ChannelPicker
            plugins={plugins}
            onPick={(kind) => void addAccountOfKind(kind)}
            onClose={() => setShowPicker(false)}
          />
        )}
        {accountModalKey && settings && (
          <AccountModal
            key={`${accountModalKey}:${focusProxyKey === accountModalKey ? 'proxy' : 'edit'}`}
            accountKey={accountModalKey}
            plugin={plugins.find((p) => p.kind === accountModalKey.split(':')[0])}
            state={channels[accountModalKey]}
            config={settings.accounts[accountModalKey] ?? {}}
            onSave={async (key, config) => {
              await saveSettings({ accounts: { [key]: config } })
            }}
            onSettings={setSettings}
            onLogout={(key) => api.logoutChannel(key)}
            onRemove={removeAccount}
            onClose={() => { setFocusProxyKey(null); setAccountModalKey(null) }}
            focusProxy={focusProxyKey === accountModalKey}
          />
        )}
        {inheritTargetKey && (() => {
          const target = accountRows.find((a) => a.key === inheritTargetKey)
          if (!target) return null
          return <AccountInheritanceModal
            target={target}
            candidates={accountRows.filter((a) => a.key !== inheritTargetKey)}
            onSubmit={inheritAccountConversations}
            onClose={() => setInheritTargetKey(null)}
          />
        })()}
        {quitConfirmOpen && (
          <div className="quit-modal-backdrop" role="presentation" onMouseDown={() => setQuitConfirmOpen(false)}>
            <section className="quit-modal" role="dialog" aria-modal="true" aria-labelledby="quit-modal-title" onMouseDown={(event) => event.stopPropagation()}>
              <div className="quit-modal-icon"><LogOut size={42} strokeWidth={2.4} /></div>
              <h2 id="quit-modal-title">{t('app.quitTitle')}</h2>
              <p>{t('app.quitConfirm')}</p>
              <div className="quit-modal-actions">
                <button type="button" className="quit-cancel" onClick={() => setQuitConfirmOpen(false)}><X size={21} />{t('app.quitCancel')}</button>
                <button type="button" className="quit-confirm" onClick={() => void api.quitApp()}><Check size={21} />{t('app.quit')}</button>
              </div>
            </section>
          </div>
        )}
      </div>
    </I18nProvider>
  )
}
