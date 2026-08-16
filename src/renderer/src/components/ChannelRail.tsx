import type { ChannelState } from '@shared/domain'
import { useI18n } from '../i18n'

const STATUS_COLOR: Record<string, string> = {
  connected: 'var(--ok)',
  connecting: 'var(--warn)',
  waiting_qr: 'var(--warn)',
  error: 'var(--danger)',
  logged_out: 'var(--muted)',
  stopped: 'var(--muted)'
}

function WhatsAppIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 1.8a8.2 8.2 0 1 1-4.2 15.3l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 0 1 12 3.8Zm-3.1 4c-.2 0-.5.1-.7.3-.2.3-.9.9-.9 2.1s.9 2.4 1 2.6c.1.2 1.8 2.8 4.3 3.8 2.1.9 2.6.7 3 .7.5 0 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2l-.4-.2-1.5-.7c-.2-.1-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.1-.2 0-.4.1-.5l.5-.6c.1-.2.2-.3.1-.5l-.7-1.7c-.2-.4-.3-.4-.5-.4h-.2Z" />
    </svg>
  )
}

interface Props {
  channels: Record<string, ChannelState>
  onChannelClick: (key: string) => void
  onOpenSettings: () => void
}

export function ChannelRail({ channels, onChannelClick, onOpenSettings }: Props): React.JSX.Element {
  const { t } = useI18n()
  const wa = channels['whatsapp:main']
  const waTitle = `${t('channel.whatsapp')} — ${t(`status.${wa?.status ?? 'stopped'}` as 'status.stopped')}`

  return (
    <nav className="rail">
      <div className="rail-logo" title={t('app.name')}>
        OC
      </div>
      <button
        type="button"
        className="rail-item"
        title={waTitle}
        onClick={() => onChannelClick('whatsapp:main')}
      >
        <WhatsAppIcon />
        <span
          className="status-dot"
          style={{ background: STATUS_COLOR[wa?.status ?? 'stopped'] }}
        />
      </button>
      <button type="button" className="rail-item disabled" title={t('channel.telegram')} disabled>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
          <path d="M21.9 4.6c.3-1.1-.8-2-1.8-1.6L2.7 9.7c-1.1.4-1.1 2 .1 2.3l4.4 1.3 1.7 5.4c.3 1 1.6 1.3 2.3.5l2.4-2.5 4.5 3.3c.9.7 2.2.2 2.4-.9l3.4-14.5ZM8.5 12.8l9.7-6.1c.2-.1.4.2.2.3l-8 7.4-.3 3-1.6-4.6Z" />
        </svg>
      </button>
      <button type="button" className="rail-item disabled" title={t('channel.line')} disabled>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
          <path d="M12 3C6.5 3 2 6.6 2 11.1c0 4 3.6 7.4 8.4 8 .3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c0 .3-.2 1 .9.6 1.1-.5 6-3.5 8.2-6C21.7 14.4 22 12.8 22 11c0-4.4-4.5-8-10-8Zm-4.9 10.6H5.2a.5.5 0 0 1-.5-.5V9.3a.5.5 0 0 1 1 0v3.3h1.4a.5.5 0 1 1 0 1Zm2.2-.5a.5.5 0 0 1-1 0V9.3a.5.5 0 0 1 1 0v3.8Zm4.6 0a.5.5 0 0 1-.9.3l-2-2.7v2.4a.5.5 0 0 1-1 0V9.3a.5.5 0 0 1 .9-.3l2 2.7V9.3a.5.5 0 0 1 1 0v3.8Zm3.9-2.4a.5.5 0 1 1 0 1h-1.4v.9h1.4a.5.5 0 1 1 0 1h-1.9a.5.5 0 0 1-.5-.5V9.3a.5.5 0 0 1 .5-.5h1.9a.5.5 0 1 1 0 1h-1.4v.9h1.4Z" />
        </svg>
      </button>
      <div className="rail-spacer" />
      <button type="button" className="rail-item" title={t('settings.title')} onClick={onOpenSettings}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z" />
        </svg>
      </button>
    </nav>
  )
}
