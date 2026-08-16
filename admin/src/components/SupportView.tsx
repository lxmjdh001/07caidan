import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, SupportMsg, SupportTicket } from '../api'
import { useI18n } from '../i18n'

interface Props {
  client: ApiClient
}

/** 工单里的贴图：受保护媒体需带令牌拉取，转成对象 URL 再显示 */
function TicketImage({ client, mediaId }: { client: ApiClient; mediaId: string }): React.JSX.Element {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let revoke = ''
    void client.mediaObjectUrl(mediaId).then((u) => {
      revoke = u
      setUrl(u)
    }).catch(() => setUrl(''))
    return () => {
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [client, mediaId])
  if (!url) return <span className="muted small">[图片]</span>
  return <img className="ticket-img" src={url} alt="" />
}

/** 支持工单（软件使用问题） */
export function SupportView({ client }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [tickets, setTickets] = useState<SupportTicket[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<SupportMsg[]>([])
  const [reply, setReply] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setErr('')
    try {
      setTickets((await client.listSupportTickets()).tickets)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [client])

  const open = useCallback(
    async (id: string) => {
      setActiveId(id)
      const r = await client.supportTicket(id)
      setMessages(r.messages)
    },
    [client]
  )

  useEffect(() => {
    void load()
  }, [load])

  const active = tickets.find((x) => x.id === activeId) ?? null
  const statusLabel = (s: SupportTicket['status']): string => t(`sup.status.${s}` as 'sup.status.open')

  return (
    <div className="view">
      <header className="view-header">
        <h1>{t('sup.title')}</h1>
        <button className="ghost" onClick={() => void load()}>
          {t('common.refresh')}
        </button>
      </header>
      {err && <p className="err">{err}</p>}
      <div className="campaign-layout">
        <aside className="campaign-side">
          {tickets.length === 0 ? (
            <p className="muted small">{t('common.empty')}</p>
          ) : (
            <ul className="campaign-list">
              {tickets.map((tk) => (
                <li key={tk.id}>
                  <button className={activeId === tk.id ? 'on' : ''} onClick={() => void open(tk.id)}>
                    <span className="cl-name">
                      <span className={`sup-dot ${tk.status}`} />
                      {tk.title}
                    </span>
                    <span className="cl-meta">
                      #{tk.userId} · {statusLabel(tk.status)} ·{' '}
                      {new Date(tk.updatedAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className="campaign-main">
          {!active ? (
            <p className="muted">{t('sup.pick')}</p>
          ) : (
            <>
              <header className="view-header">
                <h2>{active.title}</h2>
                <span className="muted small">{statusLabel(active.status)}</span>
                {active.status !== 'closed' && (
                  <button
                    className="danger small"
                    onClick={async () => {
                      await client.closeSupportTicket(active.id)
                      await load()
                      await open(active.id)
                    }}
                  >
                    {t('sup.close')}
                  </button>
                )}
              </header>
              <div className="sup-msgs">
                {messages.map((m) => (
                  <div key={m.id} className={`sup-msg ${m.sender}`}>
                    <div className="sup-msg-head">
                      {m.sender === 'admin' ? `${t('sup.admin')}${m.senderName ? ` · ${m.senderName}` : ''}` : t('sup.user')}
                      <span>{new Date(m.createdAt).toLocaleString()}</span>
                    </div>
                    {m.body && <p>{m.body}</p>}
                    {m.mediaId && <TicketImage client={client} mediaId={m.mediaId} />}
                  </div>
                ))}
              </div>
              <div className="sup-reply">
                <textarea
                  rows={3}
                  value={reply}
                  placeholder={t('sup.replyPlaceholder')}
                  onChange={(e) => setReply(e.target.value)}
                />
                <button
                  className="primary"
                  disabled={!reply.trim()}
                  onClick={async () => {
                    const r = await client.replySupportTicket(active.id, reply.trim())
                    setMessages(r.messages)
                    setReply('')
                    await load()
                  }}
                >
                  {t('sup.reply')}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
