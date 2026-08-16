import { useEffect, useRef, useState } from 'react'
import type { Conversation, MessageBody, UnifiedMessage } from '@shared/domain'
import { previewOf } from '@shared/domain'
import { useI18n } from '../i18n'
import { formatBubbleTime } from '../time'

interface Props {
  conversation: Conversation | null
  messages: UnifiedMessage[]
  connected: boolean
  onSend: (text: string) => Promise<void>
}

function bodyText(body: MessageBody): string {
  return body.type === 'text' ? body.text : previewOf(body)
}

export function ChatView({ conversation, messages, connected, onSend }: Props): React.JSX.Element {
  const { t, locale } = useI18n()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, conversation?.id])

  if (!conversation) {
    return (
      <div className="chat-empty">
        <p>{connected ? t('connected.empty') : t('chat.empty')}</p>
      </div>
    )
  }

  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setDraft('')
    try {
      await onSend(text)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="chat-title">{conversation.title}</div>
        <div className="chat-subtitle">
          <span className="channel-chip">{t('channel.whatsapp')}</span>
          {conversation.isGroup ? ' · 群组' : ''}
        </div>
      </header>
      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((m) => (
          <div key={m.id} className={`bubble-row ${m.direction === 'out' ? 'out' : 'in'}`}>
            <div className="bubble">
              {conversation.isGroup && m.direction === 'in' && m.authorName && (
                <div className="bubble-author">{m.authorName}</div>
              )}
              <div className="bubble-text">{bodyText(m.body)}</div>
              {m.translation && (
                <div className="bubble-translation">
                  {m.translation.text}
                  <span className="translation-meta">
                    {t('chat.original')} · {m.translation.engine}
                  </span>
                </div>
              )}
              <div className="bubble-meta">
                {formatBubbleTime(m.timestamp, locale)}
                {m.direction === 'out' && (
                  <span className={`tick ${m.status}`}>
                    {m.status === 'failed' ? `✗ ${t('chat.sendFailed')}` : '✓'}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      <footer className="composer">
        <textarea
          rows={1}
          value={draft}
          placeholder={t('chat.composer.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <button
          type="button"
          className="send-btn"
          disabled={!draft.trim() || sending}
          onClick={() => void submit()}
        >
          {t('chat.send')}
        </button>
      </footer>
    </div>
  )
}
