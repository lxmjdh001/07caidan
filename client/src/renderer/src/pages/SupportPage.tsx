import { useCallback, useEffect, useState } from 'react'
import { errText } from '../errors'
import { useI18n } from '../i18n'

const api = window.omni

interface Ticket {
  id: string
  title: string
  status: 'open' | 'replied' | 'closed'
  updatedAt: number
}

interface Msg {
  id: number
  sender: 'user' | 'admin'
  senderName?: string
  body: string
  mediaId?: string
  createdAt: number
}

/** 受保护贴图：经主进程带令牌拉取，返回 base64 data URL 直接作 img src */
function TicketImage({ mediaId }: { mediaId: string }): React.JSX.Element {
  const [url, setUrl] = useState('')
  useEffect(() => {
    void api
      .billing<{ dataUrl: string }>('fetchMedia', mediaId)
      .then((r) => setUrl(r.dataUrl))
      .catch(() => setUrl(''))
  }, [mediaId])
  if (!url) return <span className="field-hint">[图片]</span>
  return <img className="ticket-img" src={url} alt="" />
}

/**
 * 帮助与反馈：向运营方提交软件使用问题（支持贴图），查看与追问回复。
 * 注意：这是"软件支持工单"，与打粉的引流工单完全是两回事。
 */
export function SupportPage(): React.JSX.Element {
  const { t } = useI18n()
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [err, setErr] = useState('')
  const [crisp, setCrisp] = useState(false)

  useEffect(() => {
    void api.crispAvailable().then(setCrisp)
  }, [])
  const [creating, setCreating] = useState(false)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [imageId, setImageId] = useState('')
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setErr('')
    try {
      const r = await api.billing<{ tickets: Ticket[] }>('listTickets')
      setTickets(r.tickets)
    } catch (e) {
      setErr(errText(e))
    }
  }, [])

  const open = useCallback(async (id: string) => {
    setActiveId(id)
    const r = await api.billing<{ messages: Msg[] }>('getTicket', id)
    setMessages(r.messages)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 选择本地图片并上传，拿到 mediaId */
  const pickImage = async (setTo: (id: string) => void): Promise<void> => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      if (file.size > 8 * 1024 * 1024) {
        setErr(t('sup.imgTooBig'))
        return
      }
      setBusy(true)
      try {
        const buf = new Uint8Array(await file.arrayBuffer())
        const mediaId = await api.billing<string>('uploadTicketImage', buf, file.type || 'image/png')
        setTo(mediaId)
      } catch (e) {
        setErr(errText(e))
      } finally {
        setBusy(false)
      }
    }
    input.click()
  }

  const active = tickets.find((x) => x.id === activeId) ?? null
  const statusLabel = (s: Ticket['status']): string => t(`sup.status.${s}` as 'sup.status.open')

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('sup.title')}</h1>
        {crisp && (
          <button
            type="button"
            className="primary-btn crisp-btn"
            onClick={() => {
              void api.crispOpen().then((r) => {
                if (!r.ok) setErr(r.error ?? t('auth.failed'))
              })
            }}
          >
            {t('sup.liveChat')}
          </button>
        )}
      </header>
      <div className="page-body">
        {err && <p className="auth-err">{err}</p>}

        {creating ? (
          <div className="form-page">
            <section className="form-card">
              <h3>{t('sup.new')}</h3>
              <label className="field">
                <span>{t('sup.subject')}</span>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="field">
                <span>{t('sup.desc')}</span>
                <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
              </label>
              <div className="field-row">
                <button type="button" className="ghost-btn" disabled={busy} onClick={() => void pickImage(setImageId)}>
                  {imageId ? t('sup.imgAttached') : t('sup.attachImg')}
                </button>
              </div>
              <footer className="modal-footer">
                <button type="button" className="ghost-btn" onClick={() => setCreating(false)}>
                  {t('settings.cancel')}
                </button>
                <button
                  type="button"
                  className="primary-btn"
                  disabled={busy || !title.trim() || !body.trim()}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await api.billing('createTicket', {
                        title: title.trim(),
                        body,
                        mediaId: imageId || undefined
                      })
                      setTitle('')
                      setBody('')
                      setImageId('')
                      setCreating(false)
                      await load()
                    } catch (e) {
                      setErr(errText(e))
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  {t('sup.submit')}
                </button>
              </footer>
            </section>
          </div>
        ) : active ? (
          <div className="form-page">
            <div className="page-toolbar">
              <button type="button" className="ghost-btn" onClick={() => setActiveId(null)}>
                ← {t('campaign.back')}
              </button>
              <strong>{active.title}</strong>
              <span className="field-hint">{statusLabel(active.status)}</span>
            </div>
            <div className="sup-msgs">
              {messages.map((m) => (
                <div key={m.id} className={`sup-msg ${m.sender === 'user' ? 'mine' : 'theirs'}`}>
                  <div className="sup-msg-head">
                    <span>{m.sender === 'user' ? t('sup.me') : t('sup.staff')}</span>
                    <span>{new Date(m.createdAt).toLocaleString()}</span>
                  </div>
                  {m.body && <p>{m.body}</p>}
                  {m.mediaId && <TicketImage mediaId={m.mediaId} />}
                </div>
              ))}
            </div>
            {active.status !== 'closed' ? (
              <div className="sup-reply-row">
                <textarea
                  rows={3}
                  value={reply}
                  placeholder={t('sup.replyPlaceholder')}
                  onChange={(e) => setReply(e.target.value)}
                />
                <div className="sup-reply-actions">
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={busy || !reply.trim()}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        const r = await api.billing<{ messages: Msg[] }>('replyTicket', active.id, {
                          body: reply.trim()
                        })
                        setMessages(r.messages)
                        setReply('')
                        await load()
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    {t('sup.send')}
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={async () => {
                      await api.billing('closeTicket', active.id)
                      await load()
                      await open(active.id)
                    }}
                  >
                    {t('sup.resolve')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="field-hint">{t('sup.closedHint')}</p>
            )}
          </div>
        ) : (
          <div className="form-page">
            <div className="page-toolbar">
              <button type="button" className="primary-btn" onClick={() => setCreating(true)}>
                {t('sup.new')}
              </button>
            </div>
            {tickets.length === 0 ? (
              <p className="empty-hint">{t('sup.empty')}</p>
            ) : (
              <ul className="campaign-list">
                {tickets.map((tk) => (
                  <li key={tk.id}>
                    <button type="button" className="campaign-row" onClick={() => void open(tk.id)}>
                      <span className="campaign-name">{tk.title}</span>
                      <span className="campaign-meta">
                        {statusLabel(tk.status)} · {new Date(tk.updatedAt).toLocaleString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
