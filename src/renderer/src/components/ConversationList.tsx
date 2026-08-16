import { useMemo, useState } from 'react'
import type { ChannelState, Conversation } from '@shared/domain'
import { useI18n } from '../i18n'
import { formatListTime } from '../time'
import { Avatar } from './Avatar'

interface Props {
  conversations: Conversation[]
  activeId: string | null
  waState: ChannelState | undefined
  onSelect: (id: string) => void
}

export function ConversationList({
  conversations,
  activeId,
  waState,
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

  const status = waState?.status
  const showBanner = status && status !== 'connected'

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
      {showBanner && (
        <div className={`channel-banner ${status === 'error' ? 'danger' : ''}`}>
          {t(`status.${status}` as 'status.connecting')}
          {waState?.detail ? ` · ${waState.detail}` : ''}
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
