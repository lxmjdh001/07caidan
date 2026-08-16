import { useMemo, useState } from 'react'
import type { Conversation } from '../api'
import { CHANNELS, avatarColor } from '../util'

interface Props {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
}

export function ConversationList({ conversations, activeId, onSelect }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter(
      (c) => c.title.toLowerCase().includes(q) || (c.contactId ?? '').toLowerCase().includes(q)
    )
  }, [conversations, query])

  return (
    <aside className="list">
      <div className="list-head">
        <input
          placeholder="搜索客户 / 会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="count">{filtered.length}</span>
      </div>
      <div className="list-scroll">
        {filtered.map((c) => {
          const ch = CHANNELS[c.channel] ?? { label: c.channel, cls: '' }
          return (
            <div
              key={c.id}
              className={`conv ${c.id === activeId ? 'active' : ''}`}
              onClick={() => onSelect(c.id)}
            >
              <span className="avatar" style={{ background: avatarColor(c.id) }}>
                {c.title.slice(0, 1).toUpperCase()}
              </span>
              <div className="conv-main">
                <div className="conv-title">{c.title}</div>
                <div className="conv-tags">
                  <span className={`tag ${ch.cls}`}>{ch.label}</span>
                  <span className="tag acct">@{c.accountId}</span>
                  {c.contactId && <span className="tag acct">{c.contactId.replace(/^wa:/, '')}</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
