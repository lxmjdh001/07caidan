import {
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  FileText,
  KeyRound,
  MessageSquareText,
  Network,
  ShieldCheck,
  UsersRound
} from 'lucide-react'
import { useI18n } from '../i18n'

export type ManagementSection = 'subaccounts' | 'proxy' | 'workorders' | 'invites' | 'quick-messages'

interface Props {
  canSubaccounts: boolean
  canWorkorders: boolean
  onOpenSubaccounts: () => void
  onOpenWorkorders: () => void
}

interface Card {
  id: ManagementSection
  titleKey: 'management.subaccounts' | 'management.proxy' | 'management.workorders' | 'management.invites' | 'management.quickMessages'
  descKey: 'management.subaccountsDesc' | 'management.proxyDesc' | 'management.workordersDesc' | 'management.invitesDesc' | 'management.quickMessagesDesc'
  icon: React.JSX.Element
  available: boolean
  action?: () => void
}

export function ManagementPage({
  canSubaccounts,
  canWorkorders,
  onOpenSubaccounts,
  onOpenWorkorders
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const cards: Card[] = [
    {
      id: 'subaccounts',
      titleKey: 'management.subaccounts',
      descKey: 'management.subaccountsDesc',
      icon: <UsersRound size={22} />,
      available: canSubaccounts,
      action: onOpenSubaccounts
    },
    {
      id: 'proxy',
      titleKey: 'management.proxy',
      descKey: 'management.proxyDesc',
      icon: <Network size={22} />,
      available: false
    },
    {
      id: 'workorders',
      titleKey: 'management.workorders',
      descKey: 'management.workordersDesc',
      icon: <FileText size={22} />,
      available: canWorkorders,
      action: onOpenWorkorders
    },
    {
      id: 'invites',
      titleKey: 'management.invites',
      descKey: 'management.invitesDesc',
      icon: <KeyRound size={22} />,
      available: false
    },
    {
      id: 'quick-messages',
      titleKey: 'management.quickMessages',
      descKey: 'management.quickMessagesDesc',
      icon: <MessageSquareText size={22} />,
      available: false
    }
  ]

  return (
    <div className="page management-page">
      <header className="page-header management-header">
        <div>
          <div className="page-kicker"><ShieldCheck size={16} />{t('management.kicker')}</div>
          <h1>{t('management.title')}</h1>
          <p className="management-subtitle">{t('management.subtitle')}</p>
        </div>
        <div className="management-summary">
          <span>{t('management.summary')}</span>
          <strong>{cards.filter((card) => card.available).length} / {cards.length}</strong>
        </div>
      </header>
      <div className="page-body management-body">
        <div className="management-grid">
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              className={`management-card ${card.available ? '' : 'is-pending'}`}
              disabled={!card.available}
              onClick={card.action}
            >
              <span className="management-card-icon">{card.icon}</span>
              <span className="management-card-content">
                <strong>{t(card.titleKey)}</strong>
                <span>{t(card.descKey)}</span>
              </span>
              <span className={`management-card-status ${card.available ? 'ready' : 'pending'}`}>
                {card.available ? <><CheckCircle2 size={16} />{t('management.available')}</> : <><CircleDashed size={16} />{t('management.pending')}</>}
              </span>
              {card.available && <ChevronRight className="management-card-arrow" size={18} />}
            </button>
          ))}
        </div>
        <div className="management-tip">
          <ShieldCheck size={17} />
          <span>{t('management.tip')}</span>
        </div>
      </div>
    </div>
  )
}
