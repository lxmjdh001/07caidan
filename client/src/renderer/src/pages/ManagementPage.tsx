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
      available: canSubaccounts,
      action: onOpenSubaccounts
    },
    {
      id: 'proxy',
      titleKey: 'management.proxy',
      descKey: 'management.proxyDesc',
      available: false
    },
    {
      id: 'workorders',
      titleKey: 'management.workorders',
      descKey: 'management.workordersDesc',
      available: canWorkorders,
      action: onOpenWorkorders
    },
    {
      id: 'invites',
      titleKey: 'management.invites',
      descKey: 'management.invitesDesc',
      available: false
    },
    {
      id: 'quick-messages',
      titleKey: 'management.quickMessages',
      descKey: 'management.quickMessagesDesc',
      available: false
    }
  ]

  return (
    <div className="page management-page">
      <header className="page-header management-header">
        <div>
          <div className="page-kicker">{t('management.kicker')}</div>
          <h1>{t('management.title')}</h1>
          <p className="management-subtitle">{t('management.subtitle')}</p>
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
              <span className="management-card-content">
                <strong>{t(card.titleKey)}</strong>
                <span>{t(card.descKey)}</span>
              </span>
              <span className={`management-card-status ${card.available ? 'ready' : 'pending'}`}>
                {card.available ? t('management.available') : t('management.pending')}
              </span>
            </button>
          ))}
        </div>
        <div className="management-tip">
          <span>{t('management.tip')}</span>
        </div>
      </div>
    </div>
  )
}
