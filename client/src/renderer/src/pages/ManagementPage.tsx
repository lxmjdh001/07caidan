import { useI18n } from '../i18n'

export type ManagementSection = 'subaccounts' | 'proxy' | 'workorders' | 'invites' | 'quick-messages'

interface Props {
  canSubaccounts: boolean
  canProxy: boolean
  canWorkorders: boolean
  canQuickMessages: boolean
  onOpenSubaccounts: () => void
  onOpenProxy: () => void
  onOpenWorkorders: () => void
  onOpenQuickMessages: () => void
  onOpenInvites: () => void
}

interface Card {
  id: ManagementSection
  titleKey: 'management.subaccounts' | 'management.proxy' | 'management.workorders' | 'management.invites' | 'management.quickMessages'
  descKey: 'management.subaccountsDesc' | 'management.proxyDesc' | 'management.workordersDesc' | 'management.invitesDesc' | 'management.quickMessagesDesc'
  available: boolean
  visible: boolean
  action?: () => void
}

export function ManagementPage({
  canSubaccounts,
  canProxy,
  canWorkorders,
  canQuickMessages,
  onOpenSubaccounts,
  onOpenProxy,
  onOpenWorkorders,
  onOpenQuickMessages,
  onOpenInvites
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const cards: Card[] = [
    {
      id: 'subaccounts',
      titleKey: 'management.subaccounts',
      descKey: 'management.subaccountsDesc',
      available: true,
      visible: canSubaccounts,
      action: onOpenSubaccounts
    },
    {
      id: 'proxy',
      titleKey: 'management.proxy',
      descKey: 'management.proxyDesc',
      available: true,
      visible: canProxy,
      action: onOpenProxy
    },
    {
      id: 'workorders',
      titleKey: 'management.workorders',
      descKey: 'management.workordersDesc',
      available: true,
      visible: canWorkorders,
      action: onOpenWorkorders
    },
    {
      id: 'invites',
      titleKey: 'management.invites',
      descKey: 'management.invitesDesc',
      available: true,
      visible: canSubaccounts,
      action: onOpenInvites
    },
    {
      id: 'quick-messages',
      titleKey: 'management.quickMessages',
      descKey: 'management.quickMessagesDesc',
      available: true,
      visible: canQuickMessages,
      action: onOpenQuickMessages
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
          {cards.filter((card) => card.visible).map((card) => (
            <button
              key={card.id}
              type="button"
              data-testid={`management-${card.id}`}
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
