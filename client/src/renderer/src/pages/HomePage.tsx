import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  BadgeCheck,
  CircleAlert,
  CircleUserRound,
  CreditCard,
  Megaphone,
} from 'lucide-react'
import type { ChannelPluginInfo } from '@shared/ipc'
import type { ChannelState } from '@shared/domain'
import type { AppSettings } from '@shared/settings'
import { useI18n } from '../i18n'
import whatsappLogo from '../assets/platforms/whatsapp.svg'
import telegramLogo from '../assets/platforms/telegram.svg'
import lineLogo from '../assets/platforms/line.svg'

const api = window.omni

interface BillingMe {
  balance?: { balanceCents: number; credits: number }
  subscription?: { planId: string; expiresAt: number; autoRenew: boolean; status: string } | null
  plan?: { name: string; maxAccounts: number; priceCents: number } | null
  accountQuota?: number
}

interface Announcement {
  id: string
  title: string
  body: string
  createdAt: number
}

interface Props {
  settings: AppSettings
  channels: Record<string, ChannelState>
  plugins: ChannelPluginInfo[]
  onOpenApp: (kind: string) => void
  onOpenManagement: () => void
  onOpenSubaccounts: () => void
  onOpenWorkorders: () => void
  canSubaccounts: boolean
  canWorkorders: boolean
  onRefresh: () => void
}

const APP_META: Record<string, { name: string; logo: string }> = {
  whatsapp: { name: 'WhatsApp', logo: whatsappLogo },
  telegram: { name: 'Telegram', logo: telegramLogo },
  line: { name: 'LINE', logo: lineLogo }
}

function money(cents = 0): string {
  return `$${(cents / 100).toFixed(2)}`
}

function dateText(ts?: number): string {
  return ts ? new Date(ts).toLocaleDateString() : '—'
}

export function HomePage({ settings, channels, plugins, onOpenApp, onOpenManagement, onOpenSubaccounts, onOpenWorkorders, canSubaccounts, canWorkorders, onRefresh }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [billing, setBilling] = useState<BillingMe | null>(null)
  const [announcements, setAnnouncements] = useState<Announcement[]>([])

  useEffect(() => {
    void api.billing<BillingMe>('me').then(setBilling).catch(() => setBilling(null))
    void api
      .billing<{ announcements: Announcement[] }>('listNotices')
      .then((r) => setAnnouncements(r.announcements ?? []))
      .catch(() => setAnnouncements([]))
  }, [])

  const supportedKinds = useMemo(() => {
    const kinds = new Set(plugins.map((p) => p.kind))
    kinds.add('whatsapp')
    kinds.add('telegram')
    kinds.add('line')
    return ['whatsapp', 'telegram', 'line'].filter((kind) => kinds.has(kind))
  }, [plugins])

  const whatsappAccounts = Object.values(channels).filter((s) => s.kind === 'whatsapp')
  const connected = whatsappAccounts.filter((s) => s.status === 'connected').length

  return (
    <div className="home-page">
      <div className="home-heading">
        <div>
          <span className="home-eyebrow">{t('home.eyebrow')}</span>
          <h1>{t('home.title')}</h1>
          <p>{t('home.subtitle')}</p>
        </div>
        <button type="button" className="home-refresh" onClick={onRefresh}>
          <span>{t('home.refresh')}</span>
          <ArrowRight size={16} />
        </button>
      </div>

      <section className="home-section member-section">
        <div className="section-title-row">
          <div className="section-title"><CircleUserRound size={20} /><h2>{t('home.member')}</h2></div>
          <span className="section-caption">{t('home.memberCaption')}</span>
        </div>
        <div className="member-grid">
          <div className="member-identity">
            <div className="member-avatar">{(settings.sync.email || 'U').slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{settings.sync.email || t('home.notSignedIn')}</strong>
              <span>{billing?.plan?.name || t('home.noPlan')}</span>
            </div>
          </div>
          <div className="member-stat"><span>{t('home.balance')}</span><strong>{money(billing?.balance?.balanceCents)}</strong></div>
          <div className="member-stat"><span>{t('home.credits')}</span><strong>{(billing?.balance?.credits ?? 0).toLocaleString()}</strong></div>
          <div className="member-stat"><span>{t('home.quota')}</span><strong>{billing?.accountQuota || billing?.plan?.maxAccounts || 0}</strong></div>
          <div className="member-meta"><span>{t('home.expires')}</span><strong>{dateText(billing?.subscription?.expiresAt)}</strong></div>
        </div>
      </section>

      <section className="home-section app-section">
        <div className="section-title-row">
          <div className="section-title"><CreditCard size={20} /><h2>{t('home.apps')}</h2></div>
          <span className="section-caption">{t('home.appsCaption').replace('{count}', String(connected))}</span>
        </div>
        <div className="home-app-grid">
          {supportedKinds.map((kind) => {
            const meta = APP_META[kind]!
            const available = kind === 'whatsapp'
            return (
              <button
                type="button"
                key={kind}
                className={`home-app-card ${available ? '' : 'is-disabled'}`}
                disabled={!available}
                onClick={() => available && onOpenApp(kind)}
              >
                <img className="home-app-logo" src={meta.logo} alt="" />
                <span className="home-app-body"><strong>{meta.name}</strong></span>
                <span className="home-app-status">{available ? <><BadgeCheck size={17} />{t('home.available')}</> : <><CircleAlert size={17} />{t('home.comingSoon')}</>}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="home-section management-section">
        <div className="section-title-row">
          <div className="section-title"><h2>{t('management.nav')}</h2></div>
          <button type="button" className="section-link" onClick={onOpenManagement}>{t('management.openCenter')} <ArrowRight size={15} /></button>
        </div>
        <div className="home-management-grid">
          {[
            { id: 'subaccounts', title: t('management.subaccounts'), desc: t('management.subaccountsDesc'), available: canSubaccounts, action: onOpenSubaccounts },
            { id: 'proxy', title: t('management.proxy'), desc: t('management.proxyDesc'), available: false },
            { id: 'workorders', title: t('management.workorders'), desc: t('management.workordersDesc'), available: canWorkorders, action: onOpenWorkorders },
            { id: 'invites', title: t('management.invites'), desc: t('management.invitesDesc'), available: false },
            { id: 'quick-messages', title: t('management.quickMessages'), desc: t('management.quickMessagesDesc'), available: false }
          ].map((item) => (
            <button key={item.id} type="button" className={`home-management-card ${item.available ? '' : 'is-pending'}`} disabled={!item.available} onClick={item.action}>
              <span className="home-management-copy"><strong>{item.title}</strong><span>{item.desc}</span></span>
              <span className="home-management-badge">{item.available ? t('management.available') : t('management.pending')}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="home-section notice-section">
        <div className="section-title-row">
          <div className="section-title"><Megaphone size={20} /><h2>{t('home.notices')}</h2></div>
          <span className="section-caption">{t('home.noticesCaption')}</span>
        </div>
        {announcements.length > 0 ? (
          <div className="home-notices">
            {announcements.slice(0, 5).map((item) => (
              <article className="home-notice" key={item.id}>
                <span className="notice-mark"><Megaphone size={16} /></span>
                <div><strong>{item.title}</strong><p>{item.body}</p></div>
                <time>{dateText(item.createdAt)}</time>
              </article>
            ))}
          </div>
        ) : (
          <div className="home-empty-notice"><Megaphone size={18} /><span>{t('home.noNotices')}</span></div>
        )}
      </section>
    </div>
  )
}
