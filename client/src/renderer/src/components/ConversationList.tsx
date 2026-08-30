import { useEffect, useMemo, useState } from 'react'
import { CheckCheck, Pin, PinOff } from 'lucide-react'
import type { ChannelState, Conversation } from '@shared/domain'
import { useI18n } from '../i18n'
import { formatListTime } from '../time'
import { Avatar } from './Avatar'
import { AccountTag, ChannelTag } from './ChannelTag'
import { UnreadBadge } from './UnreadBadge'

interface Props {
  conversations: Conversation[]
  activeId: string | null
  /** 当前视图相关的渠道状态（未连接的会显示横幅） */
  states: ChannelState[]
  /** channel:accountId → 账号显示名 */
  accountLabels: Record<string, string>
  /** 聚合视图（全部消息）才显示来源标签 */
  showSourceTags: boolean
  onSelect: (id: string) => void
  onTogglePinned: (id: string, pinned: boolean) => void | Promise<void>
  onMarkAllRead: () => void
}

export function ConversationList({
  conversations,
  activeId,
  states,
  accountLabels,
  showSourceTags,
  onSelect,
  onTogglePinned,
  onMarkAllRead
}: Props): React.JSX.Element {
  const { t, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })

  useEffect(() => {
    if (!menuId) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuId(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [menuId])

  const openMenu = (id: string, clientX: number, clientY: number): void => {
    const width = 196
    const height = 52
    setMenuId(id)
    setMenuPos({
      top: Math.max(8, Math.min(clientY, window.innerHeight - height - 8)),
      left: Math.max(8, Math.min(clientX, window.innerWidth - width - 8))
    })
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return conversations.filter((c) => {
      if (filter === 'unread' && !(c.unreadCount > 0)) return false
      if (!q) return true
      return (
        c.title.toLowerCase().includes(q) || c.lastMessagePreview.toLowerCase().includes(q)
      )
    })
  }, [conversations, filter, query])

  const unreadCount = useMemo(
    () => conversations.reduce((sum, conversation) => sum + (conversation.unreadCount || 0), 0),
    [conversations]
  )
  const menuConversation = menuId
    ? conversations.find((conversation) => conversation.id === menuId)
    : undefined

  // 有账号未连接时显示横幅（多账号时标注账号名）
  const issue = states.find((s) => s.status !== 'connected')
  const status = issue?.status
  const issueLabel = issue && states.length > 1 ? `${issue.selfName || issue.accountId}: ` : ''
  const issueTone = issue?.status === 'error' ? 'abnormal' : 'offline'

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h1>{t('sidebar.title')}</h1>
      </header>
      <div className="sidebar-search">
        <input
          type="text"
          placeholder={t('sidebar.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="conversation-tools">
        <button
          type="button"
          className="mark-all-read-btn"
          disabled={unreadCount === 0}
          onClick={onMarkAllRead}
          title={t('rail.markAllRead')}
        >
          <CheckCheck size={15} />
          <span>{t('rail.markAllRead')}</span>
        </button>
        <div className="conversation-filters" role="tablist" aria-label={t('sidebar.title')}>
          <button type="button" className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            {t('rail.filterAll')}
          </button>
          <button type="button" className={filter === 'unread' ? 'on' : ''} onClick={() => setFilter('unread')}>
            {t('rail.filterUnread')}
            {unreadCount > 0 && <UnreadBadge count={unreadCount} />}
          </button>
        </div>
      </div>
      {status && (
        <div className={`channel-banner ${issueTone === 'abnormal' ? 'danger' : ''}`}>
          {issueLabel}
          {t(`status.${issueTone}` as 'status.online')}
          {issue?.detail ? ` · ${issue.detail}` : ''}
        </div>
      )}
      <div className="conversation-scroll">
        {filtered.length === 0 ? (
          <div className="sidebar-empty">
            {(filter === 'unread' ? t('rail.noUnread') : t('sidebar.empty'))
              .split('\n')
              .map((line) => (
                <p key={line}>{line}</p>
              ))}
          </div>
        ) : (
          filtered.map((c) => (
            <button
              type="button"
              key={c.id}
              className={`conversation-item ${c.id === activeId ? 'active' : ''}`}
              onClick={() => onSelect(c.id)}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                openMenu(c.id, event.clientX, event.clientY)
              }}
            >
              <Avatar id={c.id} title={c.title} avatarMediaId={c.avatarMediaId} />
              <span className="conversation-main">
                <span className="conversation-top">
                  <span className="conversation-title-wrap">
                    <span className="conversation-title">{c.title}</span>
                    {c.pinned && <Pin className="conversation-pin" size={13} aria-label={t('chat.pinned')} />}
                  </span>
                  <span className="conversation-time">
                    {formatListTime(c.lastMessageAt, locale, t('time.yesterday'))}
                  </span>
                </span>
                {showSourceTags && (
                  <span className="conversation-tags">
                    <ChannelTag kind={c.channel} />
                    <AccountTag
                      label={accountLabels[`${c.channel}:${c.accountId}`] ?? c.accountId}
                    />
                  </span>
                )}
                <span className="conversation-bottom">
                  <span className="conversation-preview">{c.lastMessagePreview}</span>
                  <UnreadBadge count={c.unreadCount || 0} />
                </span>
              </span>
            </button>
          ))
        )}
      </div>
      {menuId && (
        <>
          <button
            type="button"
            className="conversation-menu-scrim"
            aria-label={t('chat.closeMenu')}
            onClick={() => setMenuId(null)}
          />
          <div
            className="conversation-context-menu"
            style={{ top: menuPos.top, left: menuPos.left }}
            role="menu"
          >
            {menuConversation && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onTogglePinned(menuConversation.id, !menuConversation.pinned)
                  setMenuId(null)
                }}
              >
                {menuConversation.pinned ? <PinOff size={17} /> : <Pin size={17} />}
                {t(menuConversation.pinned ? 'chat.unpin' : 'chat.pin')}
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
