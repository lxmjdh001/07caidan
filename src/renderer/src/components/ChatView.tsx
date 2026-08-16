import { useEffect, useRef, useState } from 'react'
import type { Conversation, MessageBody, UnifiedMessage } from '@shared/domain'
import { previewOf } from '@shared/domain'
import type { OutboundPreview } from '@shared/ipc'
import { LANGUAGES, languageLabel } from '@shared/langs'
import { useI18n } from '../i18n'
import { formatBubbleTime } from '../time'
import { Avatar } from './Avatar'
import { ChannelTag } from './ChannelTag'

interface Props {
  conversation: Conversation | null
  messages: UnifiedMessage[]
  connected: boolean
  /** 同一客户是否在其他账号/渠道有过会话 */
  knownFromOther: boolean
  onSend: (text: string, prepared?: OutboundPreview) => Promise<void>
  onSendMedia: () => Promise<void>
  /** 设置该会话的客户语言（null = 回到自动） */
  onSetLang: (lang: string | null) => Promise<void>
  /** 出站翻译预览（翻译但不发送） */
  onPreview: (text: string) => Promise<OutboundPreview>
  /** 发送前是否需要预览确认 */
  confirmBeforeSend: boolean
}

type MediaBody = Extract<MessageBody, { type: 'media' }>

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** 微信风格语音条：播放/暂停 + 声波条 + 时长（out 方向镜像布局） */
function VoiceMessage({ url, durationSec }: { url: string; durationSec?: number }): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [total, setTotal] = useState(durationSec ?? 0)
  const [elapsed, setElapsed] = useState(0)

  const toggle = (): void => {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
    } else {
      void el.play()
    }
  }

  // 气泡宽度按时长增长（微信手感），封顶 200px
  const width = 88 + Math.min(112, (total || 0) * 4)
  const shown = playing && elapsed > 0 ? total - elapsed : total

  return (
    <div className="voice-msg" style={{ width }} onClick={toggle} role="button" tabIndex={0}>
      <span className={`voice-play ${playing ? 'playing' : ''}`}>
        {playing ? (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </span>
      <span className="voice-wave" aria-hidden>
        {Array.from({ length: 14 }).map((_, i) => (
          <span key={i} className={`voice-bar ${playing ? 'anim' : ''}`} style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </span>
      <span className="voice-dur">{formatDuration(shown)}</span>
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d) && d > 0) setTotal(d)
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setElapsed(0)
        }}
        onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
      />
    </div>
  )
}

function MediaContent({ body, downloading }: { body: MediaBody; downloading: string }): React.JSX.Element {
  if (!body.mediaId) {
    return (
      <div className="media-pending">
        {previewOf(body)} <span className="media-pending-hint">{downloading}</span>
      </div>
    )
  }
  const url = `omni-media://local/${body.mediaId}`
  switch (body.mediaType) {
    case 'image':
      return <img className="media-img" src={url} alt={body.caption ?? ''} />
    case 'sticker':
      return <img className="media-sticker" src={url} alt="" />
    case 'video':
      return <video className="media-video" src={url} controls preload="metadata" />
    case 'audio':
      return <VoiceMessage url={url} durationSec={body.durationSec} />
    case 'document':
      return (
        <div className="media-doc">
          <span className="media-doc-icon">📄</span>
          <span className="media-doc-name">{body.fileName ?? previewOf(body)}</span>
        </div>
      )
  }
}

export function ChatView({
  conversation,
  messages,
  connected,
  knownFromOther,
  onSend,
  onSendMedia,
  onSetLang,
  onPreview,
  confirmBeforeSend
}: Props): React.JSX.Element {
  const { t, locale } = useI18n()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [preview, setPreview] = useState<OutboundPreview | null>(null)
  const [showConvSettings, setShowConvSettings] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setShowConvSettings(false)
    setPreview(null)
  }, [conversation?.id])

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

  const doSend = async (text: string, prepared?: OutboundPreview): Promise<void> => {
    setSending(true)
    try {
      await onSend(text, prepared)
      setDraft('')
      setPreview(null)
    } finally {
      setSending(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (sending) return
    // 预览已展示：本次提交即确认发送
    if (preview) {
      await doSend(preview.original, preview)
      return
    }
    const text = draft.trim()
    if (!text) return
    if (confirmBeforeSend) {
      setSending(true)
      let p: OutboundPreview | null = null
      try {
        p = await onPreview(text)
      } finally {
        setSending(false)
      }
      // 发生了翻译才需要确认；没翻译（同语言/引擎关闭）直接发
      if (p?.engine) {
        setPreview(p)
        return
      }
      await doSend(text)
    } else {
      await doSend(text)
    }
  }

  return (
    <div className="chat">
      <header className="chat-header">
        <Avatar
          id={conversation.id}
          title={conversation.title}
          avatarMediaId={conversation.avatarMediaId}
          size={38}
        />
        <div className="chat-header-text">
          <div className="chat-title">{conversation.title}</div>
          <div className="chat-subtitle">
            <ChannelTag kind={conversation.channel} />
            {conversation.contactId && (
              <span className="contact-id">{conversation.contactId.replace(/^wa:/, '')}</span>
            )}
            {knownFromOther && <span className="known-chip">{t('chat.knownContact')}</span>}
            {conversation.isGroup ? ' · 群组' : ''}
          </div>
        </div>
        <button
          type="button"
          className="conv-settings-btn"
          title={t('chat.settings')}
          onClick={() => setShowConvSettings((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
          </svg>
        </button>
        {showConvSettings && (
          <div className="conv-settings-popover">
            <h4>{t('chat.settings')}</h4>
            <label className="field">
              <span>{t('chat.customerLang')}</span>
              <select
                value={conversation.langOverride ?? ''}
                onChange={(e) => {
                  void onSetLang(e.target.value || null)
                }}
              >
                <option value="">
                  {t('chat.langAuto')}
                  {conversation.detectedLang
                    ? `（${t('chat.detected')}: ${languageLabel(conversation.detectedLang)}）`
                    : `（${t('chat.notDetected')}）`}
                </option>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </header>
      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((m) => (
          <div key={m.id} className={`bubble-row ${m.direction === 'out' ? 'out' : 'in'}`}>
            <div className="bubble">
              {conversation.isGroup && m.direction === 'in' && m.authorName && (
                <div className="bubble-author">{m.authorName}</div>
              )}
              {m.body.type === 'media' ? (
                <>
                  <MediaContent body={m.body} downloading={t('chat.mediaDownloading')} />
                  {m.body.caption && <div className="bubble-text">{m.body.caption}</div>}
                </>
              ) : (
                <div className="bubble-text">
                  {m.body.type === 'text' ? m.body.text : previewOf(m.body)}
                </div>
              )}
              {m.translation && (
                <div className="bubble-translation">
                  {m.translation.text}
                  <span className="translation-meta">
                    {m.direction === 'out' ? t('chat.original') : t('chat.translatedAs')} ·{' '}
                    {m.translation.engine}
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
      {preview && (
        <div className="send-preview">
          <div className="send-preview-head">
            {t('chat.previewLabel')} · {languageLabel(preview.targetLang)}
            {preview.engine ? ` · ${preview.engine}` : ''}
          </div>
          <div className="send-preview-text">{preview.send}</div>
          <div className="send-preview-actions">
            <button type="button" className="ghost-btn" onClick={() => setPreview(null)}>
              {t('settings.cancel')}
            </button>
            <button
              type="button"
              className="primary-btn"
              disabled={sending}
              onClick={() => void submit()}
            >
              {t('chat.confirmSend')}
            </button>
          </div>
        </div>
      )}
      <footer className="composer">
        <button
          type="button"
          className="attach-btn"
          title={t('chat.attach')}
          onClick={() => void onSendMedia()}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M21 12.5l-8.5 8.5a6 6 0 0 1-8.5-8.5L12.6 4a4 4 0 1 1 5.7 5.7l-8.5 8.5a2 2 0 0 1-2.8-2.8L15.5 7" />
          </svg>
        </button>
        <textarea
          rows={1}
          value={draft}
          placeholder={t('chat.composer.placeholder')}
          onChange={(e) => {
            setDraft(e.target.value)
            // 修改草稿使已生成的预览失效
            if (preview) setPreview(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
            if (e.key === 'Escape' && preview) {
              setPreview(null)
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
