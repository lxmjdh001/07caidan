import { useEffect, useState } from 'react'
import type { ApiClient, Conversation, Message } from '../api'
import { CHANNELS, avatarColor, formatTime } from '../util'

interface Props {
  client: ApiClient
  conversation: Conversation | null
}

export function ChatView({ client, conversation }: Props): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!conversation) return
    setLoading(true)
    setErr('')
    setMessages([])
    client
      .listMessages(conversation.id)
      .then(({ messages }) => setMessages(messages))
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false))
  }, [client, conversation])

  if (!conversation) {
    return (
      <div className="chat">
        <div className="empty">选择左侧会话查看聊天记录</div>
      </div>
    )
  }

  const ch = CHANNELS[conversation.channel] ?? { label: conversation.channel }

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="avatar" style={{ background: avatarColor(conversation.id) }}>
          {conversation.title.slice(0, 1).toUpperCase()}
        </span>
        <div className="info">
          <div className="t">{conversation.title}</div>
          <div className="s">
            {ch.label} · @{conversation.accountId}
            {conversation.contactId ? ` · ${conversation.contactId.replace(/^wa:/, '')}` : ''}
          </div>
        </div>
      </div>
      <div className="chat-scroll">
        {loading && <div className="spin">加载中…</div>}
        {err && <div className="empty">加载失败：{err}</div>}
        {!loading && !err && messages.length === 0 && <div className="empty">暂无消息</div>}
        {messages.map((m) => (
          <div key={m.externalId} className={`row ${m.direction === 'out' ? 'out' : 'in'}`}>
            <div className="bubble">
              <div className="bubble-text">
                {m.text
                  ? m.text
                  : `[${m.mediaType ?? m.bodyType}]${m.caption ? ' ' + m.caption : ''}`}
              </div>
              {m.translationText && <div className="tr">{m.translationText}</div>}
              <div className="meta">{formatTime(m.timestamp)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
