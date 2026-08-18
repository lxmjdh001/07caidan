import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import type { Conversation } from '../api'
import { CHANNELS, INTENT_LABEL, avatarColor } from '../util'

interface Props {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
}

type IntentFilter = 'all' | 'high' | 'medium' | 'low'
const INTENT_FILTERS: IntentFilter[] = ['all', 'high', 'medium', 'low']

export function ConversationList({ conversations, activeId, onSelect }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [intent, setIntent] = useState<IntentFilter>('all')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return conversations.filter((c) => {
      if (intent !== 'all' && c.intentLevel !== intent) return false
      if (!q) return true
      return c.title.toLowerCase().includes(q) || (c.contactId ?? '').toLowerCase().includes(q)
    })
  }, [conversations, query, intent])

  return (
    <aside className="list">
      <div className="list-head">
        <input
          placeholder={t('conv.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="count">{filtered.length}</span>
      </div>
      <div className="intent-filter">
        {INTENT_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={intent === f ? 'on' : ''}
            onClick={() => setIntent(f)}
          >
            {f === 'all' ? t('conv.intentAll') : INTENT_LABEL[f]}
          </button>
        ))}
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
                  {c.intentLevel && c.intentLevel !== 'unknown' && (
                    <span className={`tag intent-${c.intentLevel}`}>{INTENT_LABEL[c.intentLevel]}</span>
                  )}
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
