import { useEffect, useMemo, useState } from 'react'
import {
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  CircleQuestionMark,
  CreditCard,
  MoreVertical,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Settings2,
  Settings,
  Trash2,
  CheckCheck,
  LogOut
  ,UserRoundPlus
} from 'lucide-react'
import type { ChannelState } from '@shared/domain'
import { UnreadBadge } from './UnreadBadge'
import { useI18n } from '../i18n'
import whatsappLogo from '../assets/platforms/whatsapp.svg'
import telegramLogo from '../assets/platforms/telegram.svg'
import lineLogo from '../assets/platforms/line.svg'

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
  stopped: 'var(--muted)',
  disabled: 'var(--muted)'
}

const PLATFORM_META: Record<string, { label: string; color: string; logo: string }> = {
  whatsapp: { label: 'WhatsApp', color: '#25d366', logo: whatsappLogo },
  telegram: { label: 'Telegram', color: '#229ed9', logo: telegramLogo },
  telegram_bot: { label: 'Telegram Bot', color: '#229ed9', logo: telegramLogo },
  line: { label: 'LINE', color: '#06c755', logo: lineLogo }
}
const PLATFORM_ORDER = ['whatsapp', 'telegram', 'telegram_bot', 'line']

function platformMeta(kind: string): { label: string; color: string; logo: string } {
  return PLATFORM_META[kind] ?? { label: kind, color: '#94a3b8', logo: telegramLogo }
}

function statusTone(status: ChannelState['status']): 'online' | 'offline' | 'abnormal' {
  if (status === 'connected') return 'online'
  if (status === 'error') return 'abnormal'
  return 'offline'
}

export interface AccountRow {
  key: string
  label: string
  state: ChannelState
  unread: number
  disabled: boolean
}

interface Props {
  accounts: AccountRow[]
  /** 全部消息视图的总未读 */
  totalUnread: number
  /** null = 全部消息视图 */
  activeKey: string | null
  onSelect: (key: string | null) => void
  onAccountSettings: (key: string) => void
  onReconnect: (key: string) => void
  onToggleEnabled: (key: string, enabled: boolean) => void
  onMarkAccountRead: (key: string) => void
  onLogoutAccount: (key: string) => void
  onRemoveAccount: (key: string) => void
  onInheritAccount: (key: string) => void
  onAddAccount: () => void
  onOpenSettings: () => void
  onOpenBilling: () => void
  onOpenSupport: () => void
  onOpenManagement: () => void
  onQuitApplication: () => void
  /** 当前主视图，用于底部导航高亮 */
  activeView: 'chat' | 'campaigns' | 'billing' | 'support' | 'settings' | 'team' | 'management'
  showBilling: boolean
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
  onReconnect,
  onToggleEnabled,
  onMarkAccountRead,
  onLogoutAccount,
  onRemoveAccount,
  onInheritAccount,
  onAddAccount,
  onOpenSettings,
  onOpenBilling,
  onOpenSupport,
  onOpenManagement,
  onQuitApplication,
  activeView,
  showBilling,
  allowAddAccount,
  atAccountQuota,
  allowAccountSettings
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [navMenuOpen, setNavMenuOpen] = useState(false)
  const menuAccount = menuKey ? accounts.find((account) => account.key === menuKey) : undefined

  useEffect(() => {
    if (!navMenuOpen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setNavMenuOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [navMenuOpen])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return accounts
    return accounts.filter(
      (a) => a.label.toLowerCase().includes(q) || a.key.toLowerCase().includes(q)
    )
  }, [accounts, query])

  const groups = useMemo(() => {
    const map = new Map<string, AccountRow[]>()
    for (const account of filtered) {
      const list = map.get(account.state.kind) ?? []
      list.push(account)
      map.set(account.state.kind, list)
    }
    return [...map.entries()]
      .sort(([a], [b]) => {
        const ai = PLATFORM_ORDER.indexOf(a)
        const bi = PLATFORM_ORDER.indexOf(b)
        if (ai >= 0 && bi >= 0) return ai - bi
        if (ai >= 0) return -1
        if (bi >= 0) return 1
        return a.localeCompare(b)
      })
      .map(([kind, groupAccounts]) => ({ kind, accounts: groupAccounts, ...platformMeta(kind) }))
  }, [filtered])

  const openMenu = (key: string, target: HTMLElement): void => {
    const rect = target.getBoundingClientRect()
    const menuHeight = 250
    setMenuKey(key)
    setMenuPos({
      top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - menuHeight - 8)),
      left: Math.max(8, Math.min(rect.right - 184, window.innerWidth - 200))
    })
  }

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

      <div className="account-list-search">
        <Search size={15} aria-hidden />
        <input
          type="text"
          placeholder={t('rail.searchAccounts')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="account-list-scroll" onScroll={() => menuKey && setMenuKey(null)}>
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

        {groups.map((group) => {
          const isCollapsed = collapsed[group.kind] === true
          const groupUnread = group.accounts.reduce((sum, account) => sum + account.unread, 0)
          return (
            <section className="account-platform-group" key={group.kind}>
              <button
                type="button"
                className="account-platform-header"
                onClick={() => setCollapsed((prev) => ({ ...prev, [group.kind]: !isCollapsed }))}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <img src={group.logo} alt="" />
                <span>{group.label}</span>
                <span className="account-platform-count">{group.accounts.length}</span>
                <UnreadBadge count={groupUnread} />
              </button>
              {!isCollapsed && group.accounts.map((a) => {
                const meta = platformMeta(a.state.kind)
                const tone = a.disabled ? 'disabled' : statusTone(a.state.status)
                return (
                  <div
                    key={a.key}
                    className={`account-row ${activeKey === a.key ? 'active' : ''} ${a.disabled ? 'disabled' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(a.key)}
                    onContextMenu={(e) => { e.preventDefault(); openMenu(a.key, e.currentTarget) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onSelect(a.key)
                    }}
                  >
                    <span className="account-row-avatar account-row-avatar-brand" style={{ background: `${meta.color}24` }}>
                      {a.state.avatarMediaId ? (
                        <img
                          className="account-avatar-image"
                          src={`omni-media://local/${a.state.avatarMediaId}`}
                          alt=""
                          onError={(event) => {
                            // 媒体被清理或损坏时仍显示平台 Logo，不让账号列表出现破图。
                            event.currentTarget.onerror = null
                            event.currentTarget.classList.remove('account-avatar-image')
                            event.currentTarget.src = meta.logo
                          }}
                        />
                      ) : (
                        <img src={meta.logo} alt="" />
                      )}
                      <span className={`status-dot status-${tone}`} style={{ background: STATUS_COLOR[tone] }} />
                    </span>
                    <span className="account-row-main">
                      <span className="account-row-name">{a.label}</span>
                      <span className="account-row-status">{t(a.disabled ? 'status.disabled' : `status.${tone}` as 'status.online')}</span>
                    </span>
                    <UnreadBadge count={a.unread} />
                    {allowAccountSettings && (
                      <button type="button" className="account-row-more" title={t('account.more')} onClick={(e) => { e.stopPropagation(); openMenu(a.key, e.currentTarget) }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(a.key, e.currentTarget) }}>
                        <MoreVertical size={17} />
                      </button>
                    )}
                  </div>
                )
              })}
            </section>
          )
        })}

        {filtered.length === 0 && query && (
          <div className="account-list-empty">{t('rail.noMatch')}</div>
        )}
      </div>

      {menuKey && (
        <>
          <button type="button" className="account-menu-scrim" aria-label={t('account.closeMenu')} onClick={() => setMenuKey(null)} />
          <div className="account-context-menu" style={{ top: menuPos.top, left: menuPos.left }} role="menu">
            <button type="button" onClick={() => { onAccountSettings(menuKey); setMenuKey(null) }}><Settings2 size={17} />{t('account.edit')}</button>
            <button type="button" onClick={() => { onReconnect(menuKey); setMenuKey(null) }}><RefreshCw size={17} />{t('account.refresh')}</button>
            <button
              type="button"
              onClick={() => {
                onToggleEnabled(menuKey, Boolean(menuAccount?.disabled))
                setMenuKey(null)
              }}
            >
              {menuAccount?.disabled ? <Power size={17} /> : <PowerOff size={17} />}
              {t(menuAccount?.disabled ? 'account.enable' : 'account.disable')}
            </button>
            <button type="button" onClick={() => { onMarkAccountRead(menuKey); setMenuKey(null) }}><CheckCheck size={17} />{t('account.markAllRead')}</button>
            <button type="button" onClick={() => { onInheritAccount(menuKey); setMenuKey(null) }}><UserRoundPlus size={17} />{t('account.inherit')}</button>
            <button type="button" onClick={() => { onLogoutAccount(menuKey); setMenuKey(null) }}><LogOut size={17} />{t('account.logout')}</button>
            <button type="button" className="danger" onClick={() => { onRemoveAccount(menuKey); setMenuKey(null) }}><Trash2 size={17} />{t('account.delete')}</button>
          </div>
        </>
      )}

      {/* 固定在底部：整页导航收进设置按钮，账号再多也点得到 */}
      <footer className="account-list-footer">
        <button
          type="button"
          className={`account-settings-trigger ${navMenuOpen ? 'open' : ''}`}
          title={t('settings.title')}
          aria-label={t('settings.title')}
          aria-expanded={navMenuOpen}
          onClick={() => setNavMenuOpen((open) => !open)}
        >
          <Settings size={19} strokeWidth={1.8} />
          <span>{t('settings.title')}</span>
        </button>
        {navMenuOpen && (
          <>
            <button
              type="button"
              className="account-settings-scrim"
              aria-label={t('account.closeMenu')}
              onClick={() => setNavMenuOpen(false)}
            />
            <nav className="account-settings-menu" aria-label={t('settings.title')}>
              <button
                type="button"
                className={activeView === 'management' ? 'active' : ''}
                onClick={() => {
                  setNavMenuOpen(false)
                  onOpenManagement()
                }}
              >
                <BriefcaseBusiness size={21} strokeWidth={1.8} />
                <span>{t('management.nav')}</span>
              </button>
              {showBilling && (
                <button
                  type="button"
                  className={activeView === 'billing' ? 'active' : ''}
                  onClick={() => {
                    setNavMenuOpen(false)
                    onOpenBilling()
                  }}
                >
                  <CreditCard size={21} strokeWidth={1.8} />
                  <span>{t('bill.title')}</span>
                </button>
              )}
              <button
                type="button"
                className={activeView === 'support' ? 'active' : ''}
                onClick={() => {
                  setNavMenuOpen(false)
                  onOpenSupport()
                }}
              >
                <CircleQuestionMark size={21} strokeWidth={1.8} />
                <span>{t('sup.title')}</span>
              </button>
              <button
                type="button"
                className={activeView === 'settings' ? 'active' : ''}
                onClick={() => {
                  setNavMenuOpen(false)
                  onOpenSettings()
                }}
              >
                <Settings size={21} strokeWidth={1.8} />
                <span>{t('settings.system')}</span>
              </button>
              <button
                type="button"
                className="account-settings-quit"
                onClick={() => {
                  setNavMenuOpen(false)
                  onQuitApplication()
                }}
              >
                <LogOut size={21} strokeWidth={1.8} />
                <span>{t('app.quit')}</span>
              </button>
            </nav>
          </>
        )}
      </footer>
    </aside>
  )
}
