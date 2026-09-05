import { useEffect, useMemo, useState } from 'react'
import { Bell, BellOff, CheckCheck, Eraser, MessageSquareX, Pin, PinOff, Plus, UserRoundPlus, UsersRound, X } from 'lucide-react'
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
  onToggleMuted: (id: string, muted: boolean) => void | Promise<void>
  onClearChat: (id: string) => void | Promise<void>
  onDeleteChat: (id: string) => void | Promise<void>
  onMarkAllRead: () => void
  accountKey?: string | null
  onRefreshGroups: () => void | Promise<void>
  onCreateGroup: (subject: string, participantIds: string[]) => void | Promise<void>
}

export function ConversationList({
  conversations,
  activeId,
  states,
  accountLabels,
  showSourceTags,
  onSelect,
  onTogglePinned,
  onToggleMuted,
  onClearChat,
  onDeleteChat,
  onMarkAllRead,
  accountKey,
  onRefreshGroups,
  onCreateGroup
}: Props): React.JSX.Element {
  const { t, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'unread' | 'groups'>('all')
  const [showGroupModal, setShowGroupModal] = useState(false)
  const [showAddContactInfo, setShowAddContactInfo] = useState(false)
  const [showCreateMenu, setShowCreateMenu] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([])
  const [groupBusy, setGroupBusy] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const supportsGroups = !!accountKey && (
    accountKey.startsWith('whatsapp:') || accountKey.startsWith('telegram:')
  )
  const supportsAddContact = !!accountKey && accountKey.startsWith('whatsapp:')

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
    const height = 190
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
      if (filter === 'groups' && !c.isGroup) return false
      if (!q) return true
      return (
        c.title.toLowerCase().includes(q) || c.lastMessagePreview.toLowerCase().includes(q)
      )
    })
  }, [conversations, filter, query])

  const groupContacts = conversations.filter((conversation) => {
    if (conversation.isGroup) return false
    if (accountKey && `${conversation.channel}:${conversation.accountId}` !== accountKey) return false
    // Telegram 的广播频道同样以 g<id> 保存，但不能作为建群成员。
    if (conversation.channel === 'telegram' && conversation.externalChatId.startsWith('g')) return false
    return true
  })

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
        <button
          type="button"
          className="sidebar-add-btn"
          title={t('groups.new')}
          disabled={!supportsGroups}
          onClick={() => setShowCreateMenu((visible) => !visible)}
        >
          <Plus size={20} />
        </button>
        {showCreateMenu && (
          <div className="sidebar-create-menu" role="menu">
            <button type="button" role="menuitem" disabled={!supportsGroups} onClick={() => { setShowCreateMenu(false); setShowGroupModal(true) }}>
              <UsersRound size={17} />
              {t('groups.new')}
            </button>
            <button type="button" role="menuitem" disabled={!supportsAddContact} onClick={() => { setShowCreateMenu(false); setShowAddContactInfo(true) }}>
              <UserRoundPlus size={17} />
              {t('contacts.add')}
            </button>
          </div>
        )}
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
          <button
            type="button"
            className={filter === 'groups' ? 'on' : ''}
            disabled={!supportsGroups}
            onClick={() => {
              setFilter('groups')
              void onRefreshGroups()
            }}
          >
            <UsersRound size={15} />
            {t('groups.tab')}
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
                    {c.muted && <BellOff className="conversation-pin" size={13} aria-label={t('chat.mute')} />}
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
              <>
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
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (window.confirm(t('chat.confirmClear'))) void onClearChat(menuConversation.id)
                    setMenuId(null)
                  }}
                >
                  <Eraser size={17} />
                  {t('chat.clearChat')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (window.confirm(t('chat.confirmDelete'))) void onDeleteChat(menuConversation.id)
                    setMenuId(null)
                  }}
                >
                  <MessageSquareX size={17} />
                  {t('chat.deleteChat')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void onToggleMuted(menuConversation.id, !menuConversation.muted)
                    setMenuId(null)
                  }}
                >
                  {menuConversation.muted ? <Bell size={17} /> : <BellOff size={17} />}
                  {t(menuConversation.muted ? 'chat.unmute' : 'chat.mute')}
                </button>
              </>
            )}
          </div>
        </>
      )}
      {showGroupModal && (
        <div className="group-modal-scrim" role="presentation" onMouseDown={() => setShowGroupModal(false)}>
          <section className="group-modal" role="dialog" aria-modal="true" aria-labelledby="new-group-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="group-modal-head">
              <h2 id="new-group-title">{t('groups.new')}</h2>
              <button type="button" className="icon-btn" title={t('chat.closeMenu')} onClick={() => setShowGroupModal(false)}><X size={18} /></button>
            </div>
            <label className="field">
              <span>{t('groups.name')}</span>
              <input value={groupName} onChange={(event) => setGroupName(event.target.value)} autoFocus />
            </label>
            <div className="group-member-label">{t('groups.selectMembers')} ({selectedParticipants.length})</div>
            <div className="group-member-list">
              {groupContacts.length === 0 ? <p className="muted small">{t('groups.noContacts')}</p> : groupContacts.map((contact) => {
                const selected = selectedParticipants.includes(contact.externalChatId)
                return (
                  <label className={`group-member ${selected ? 'selected' : ''}`} key={contact.id}>
                    <input type="checkbox" checked={selected} onChange={() => setSelectedParticipants((current) => selected ? current.filter((id) => id !== contact.externalChatId) : [...current, contact.externalChatId])} />
                    <span className="group-member-avatar"><Avatar id={contact.id} title={contact.title} avatarMediaId={contact.avatarMediaId} size={32} /></span>
                    <span>{contact.title}</span>
                  </label>
                )
              })}
            </div>
            <div className="group-modal-actions">
              <button type="button" className="ghost-btn group-cancel-btn" onClick={() => setShowGroupModal(false)}>{t('settings.cancel')}</button>
              <button type="button" className="primary-btn group-create-btn" disabled={groupBusy || !groupName.trim() || selectedParticipants.length === 0} onClick={async () => { setGroupBusy(true); try { await onCreateGroup(groupName.trim(), selectedParticipants); setShowGroupModal(false); setGroupName(''); setSelectedParticipants([]) } finally { setGroupBusy(false) } }}>{t('groups.create')}</button>
            </div>
          </section>
        </div>
      )}
      {showAddContactInfo && (
        <div className="group-modal-scrim" role="presentation" onMouseDown={() => setShowAddContactInfo(false)}>
          <section className="contact-info-modal" role="dialog" aria-modal="true" aria-labelledby="add-contact-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="contact-info-icon"><UserRoundPlus size={30} /></div>
            <h2 id="add-contact-title">{t('contacts.addTitle')}</h2>
            <p>{t('contacts.addDescription')}</p>
            <p className="contact-info-path">{t('contacts.addPath')}</p>
            <div className="group-modal-actions">
              <button type="button" className="primary-btn group-create-btn" onClick={() => setShowAddContactInfo(false)}>{t('contacts.confirm')}</button>
            </div>
          </section>
        </div>
      )}
    </aside>
  )
}
