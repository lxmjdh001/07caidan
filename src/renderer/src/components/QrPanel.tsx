import { useI18n } from '../i18n'

export function QrPanel({ qrDataUrl }: { qrDataUrl?: string }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="qr-panel">
      <div className="qr-card">
        <h2>{t('qr.title')}</h2>
        <ol>
          <li>{t('qr.step1')}</li>
          <li>{t('qr.step2')}</li>
          <li>{t('qr.step3')}</li>
        </ol>
        {qrDataUrl ? (
          <img className="qr-img" src={qrDataUrl} alt="WhatsApp QR" />
        ) : (
          <div className="qr-placeholder">{t('qr.waiting')}</div>
        )}
        <p className="qr-hint">{t('qr.hint')}</p>
      </div>
    </div>
  )
}
