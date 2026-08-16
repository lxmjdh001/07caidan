import { useMemo, useState } from 'react'
import type { ChannelState, Conversation } from '@shared/domain'
import { useI18n } from '../i18n'
import { formatListTime } from '../time'
import { Avatar } from './Avatar'
import { AccountTag, ChannelTag } from './ChannelTag'

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
}

export function ConversationList({
  conversations,
  activeId,
  states,
  accountLabels,
  showSourceTags,
  onSelect
}: Props): React.JSX.Element {
  const { t, locale } = useI18n()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter(
      (c) => c.title.toLowerCase().includes(q) || c.lastMessagePreview.toLowerCase().includes(q)
    )
  }, [conversations, query])

  // 有账号未连接时显示横幅（多账号时标注账号名）
  const issue = states.find((s) => s.status !== 'connected')
  const status = issue?.status
  const issueLabel =
    issue && states.length > 1 ? `${issue.selfName || issue.accountId}: ` : ''

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
      {status && (
        <div className={`channel-banner ${status === 'error' ? 'danger' : ''}`}>
          {issueLabel}
          {t(`status.${status}` as 'status.connecting')}
          {issue?.detail ? ` · ${issue.detail}` : ''}
        </div>
      )}
      <div className="conversation-scroll">
        {filtered.length === 0 ? (
          <div className="sidebar-empty">
            {t('sidebar.empty')
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
            >
              <Avatar id={c.id} title={c.title} avatarMediaId={c.avatarMediaId} />
              <span className="conversation-main">
                <span className="conversation-top">
                  <span className="conversation-title">{c.title}</span>
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
                  {c.unreadCount > 0 && <span className="unread-badge">{c.unreadCount}</span>}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  )
}
