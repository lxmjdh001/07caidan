import { useMemo, useState } from 'react'
import type { ChannelState } from '@shared/domain'
import { UnreadBadge } from './UnreadBadge'
import { useI18n } from '../i18n'

const STATUS_COLOR: Record<string, string> = {
  connected: 'var(--ok)',
  connecting: 'var(--warn)',
  waiting_qr: 'var(--warn)',
  need_credentials: 'var(--warn)',
  waiting_phone: 'var(--warn)',
  waiting_code: 'var(--warn)',
  waiting_password: 'var(--warn)',
  error: 'var(--danger)',
  logged_out: 'var(--muted)',
  stopped: 'var(--muted)'
}

const AVATAR_COLORS = ['#4f9cf9', '#22a06b', '#e8833a', '#9a6ff0', '#e5588c', '#2fb5b5']
function avatarColor(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!
}

export interface AccountRow {
  key: string
  label: string
  state: ChannelState
  unread: number
}

interface Props {
  accounts: AccountRow[]
  /** 全部消息视图的总未读 */
  totalUnread: number
  /** null = 全部消息视图 */
  activeKey: string | null
  onSelect: (key: string | null) => void
  onAccountSettings: (key: string) => void
  onAddAccount: () => void
  onOpenSettings: () => void
  onOpenCampaigns: () => void
  onOpenBilling: () => void
  onOpenSupport: () => void
  onOpenTeam: () => void
  /** 当前主视图，用于底部导航高亮 */
  activeView: 'chat' | 'campaigns' | 'billing' | 'support' | 'settings' | 'team'
  /** 客户端 RBAC：无权限的入口整个隐藏（服务端另有强制） */
  showCampaigns: boolean
  showBilling: boolean
  showTeam: boolean
  allowAddAccount: boolean
  /** 已达套餐账号配额上限：有权限但不能再加，加号禁用并提示升级 */
  atAccountQuota: boolean
  allowAccountSettings: boolean
}

export function AccountList({
  accounts,
  totalUnread,
  activeKey,
  onSelect,
  onAccountSettings,
  onAddAccount,
  onOpenSettings,
  onOpenCampaigns,
  onOpenBilling,
  onOpenSupport,
  onOpenTeam,
  activeView,
  showCampaigns,
  showBilling,
  showTeam,
  allowAddAccount,
  atAccountQuota,
  allowAccountSettings
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return accounts
    return accounts.filter(
      (a) => a.label.toLowerCase().includes(q) || a.key.toLowerCase().includes(q)
    )
  }, [accounts, query])

  return (
    <aside className="account-list">
      <header className="account-list-header">
        <span className="account-list-title">{t('rail.accounts')}</span>
        <span className="account-list-count">{accounts.length}</span>
        {allowAddAccount && (
        <button
          type="button"
          className="icon-btn"
          title={atAccountQuota ? t('rail.accountQuotaFull') : t('rail.addAccount')}
          disabled={atAccountQuota}
          onClick={onAddAccount}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        )}
      </header>
      {allowAddAccount && atAccountQuota && (
        <p className="account-quota-hint">{t('rail.accountQuotaFull')}</p>
      )}

      {accounts.length > 6 && (
        <div className="account-list-search">
          <input
            type="text"
            placeholder={t('rail.searchAccounts')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      <div className="account-list-scroll">
        <button
          type="button"
          className={`account-row all ${activeKey === null ? 'active' : ''}`}
          onClick={() => onSelect(null)}
        >
          <span className="account-row-avatar all">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.8-.8L3 20l1.1-5A8 8 0 0 1 3.5 11.5 8.4 8.4 0 0 1 12 3.2a8.4 8.4 0 0 1 9 8.3Z" />
            </svg>
          </span>
          <span className="account-row-main">
            <span className="account-row-name">{t('rail.allChats')}</span>
          </span>
          <UnreadBadge count={totalUnread} />
        </button>

        {filtered.map((a) => (
          <div
            key={a.key}
            className={`account-row ${activeKey === a.key ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(a.key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect(a.key)
            }}
          >
            <span className="account-row-avatar" style={{ background: avatarColor(a.key) }}>
              {a.label.slice(0, 1).toUpperCase()}
              <span className="status-dot" style={{ background: STATUS_COLOR[a.state.status] }} />
            </span>
            <span className="account-row-main">
              <span className="account-row-name">{a.label}</span>
              <span className="account-row-status">
                {t(`status.${a.state.status}` as 'status.stopped')}
              </span>
            </span>
            <UnreadBadge count={a.unread} />
            {allowAccountSettings && (
            <button
              type="button"
              className="account-row-gear"
              title={t('account.settings')}
              onClick={(e) => {
                e.stopPropagation()
                onAccountSettings(a.key)
              }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
              </svg>
            </button>
            )}
          </div>
        ))}

        {filtered.length === 0 && query && (
          <div className="account-list-empty">{t('rail.noMatch')}</div>
        )}
      </div>

      {/* 固定在底部：工单与全局设置不随账号列表滚动，账号再多也点得到 */}
      <footer className="account-list-footer">
        {showCampaigns && (
        <button
          type="button"
          className={`rail-nav ${activeView === 'campaigns' ? 'active' : ''}`}
          onClick={onOpenCampaigns}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M3 3v18h18" />
            <path d="M7 15l4-5 3 3 5-7" />
          </svg>
          <span>{t('campaign.title')}</span>
        </button>
        )}
        {showBilling && (
        <button
          type="button"
          className={`rail-nav ${activeView === 'billing' ? 'active' : ''}`}
          onClick={onOpenBilling}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <path d="M2 10h20" />
          </svg>
          <span>{t('bill.title')}</span>
        </button>
        )}
        {showTeam && (
        <button
          type="button"
          className={`rail-nav ${activeView === 'team' ? 'active' : ''}`}
          onClick={onOpenTeam}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9.5" cy="7.5" r="3.5" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M15.5 4.13a3.5 3.5 0 0 1 0 6.74" />
          </svg>
          <span>{t('team.title')}</span>
        </button>
        )}
        <button
          type="button"
          className={`rail-nav ${activeView === 'support' ? 'active' : ''}`}
          onClick={onOpenSupport}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5M12 18h.01" />
          </svg>
          <span>{t('sup.title')}</span>
        </button>
        <button
          type="button"
          className={`rail-nav ${activeView === 'settings' ? 'active' : ''}`}
          onClick={onOpenSettings}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
          <span>{t('settings.title')}</span>
        </button>
      </footer>
    </aside>
  )
}
