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
  /** null = 全部消息视图 */
  activeKey: string | null
  onSelect: (key: string | null) => void
  onAddAccount: () => void
  onOpenSettings: () => void
}

/** 账号显示名：登录名 > 自定义序号 */
function accountLabel(state: ChannelState, index: number): string {
  return state.selfName || `账号 ${index + 1}`
}

export function ChannelRail({
  channels,
  activeKey,
  onSelect,
  onAddAccount,
  onOpenSettings
}: Props): React.JSX.Element {
  const { t } = useI18n()
  // 账号排序：main 永远在前，其余按 key 稳定排序
  const waAccounts = Object.entries(channels)
    .filter(([key]) => key.startsWith('whatsapp:'))
    .sort(([a], [b]) => {
      if (a === 'whatsapp:main') return -1
      if (b === 'whatsapp:main') return 1
      return a.localeCompare(b)
    })

  return (
    <nav className="rail">
      <button
        type="button"
        className={`rail-item rail-all ${activeKey === null ? 'active' : ''}`}
        title={t('rail.allChats')}
        onClick={() => onSelect(null)}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.8-.8L3 20l1.1-5A8 8 0 0 1 3.5 11.5 8.4 8.4 0 0 1 12 3.2a8.4 8.4 0 0 1 9 8.3Z" />
        </svg>
      </button>

      <div className="rail-divider" />

      {waAccounts.map(([key, state], i) => (
        <button
          type="button"
          key={key}
          className={`rail-item ${activeKey === key ? 'active' : ''}`}
          title={`WhatsApp · ${accountLabel(state, i)} — ${t(`status.${state.status}` as 'status.stopped')}`}
          onClick={() => onSelect(key)}
        >
          <WhatsAppIcon />
          {waAccounts.length > 1 && <span className="rail-index">{i + 1}</span>}
          <span className="status-dot" style={{ background: STATUS_COLOR[state.status] }} />
        </button>
      ))}

      <button
        type="button"
        className="rail-item rail-add"
        title={t('rail.addAccount')}
        onClick={onAddAccount}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M12 5v14M5 12h14" />
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
