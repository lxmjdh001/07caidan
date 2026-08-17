import { useState } from 'react'
import { errText } from '../errors'
import { useI18n } from '../i18n'

const api = window.omni

interface Props {
  /** 当前等待登录的账号 key（提交手机号用） */
  accountKey?: string
  qrDataUrl?: string
  /** 已申请到的配对码；有值时展示配对码流程 */
  pairingCode?: string
}

/**
 * WhatsApp 登录面板：默认扫码，可切换为「手机号登录」——
 * 输入手机号拿到 8 位配对码，在手机 App 内输入完成关联（无需扫码）。
 */
export function QrPanel({ accountKey, qrDataUrl, pairingCode }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [mode, setMode] = useState<'qr' | 'phone'>('qr')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const requestCode = async (): Promise<void> => {
    if (!accountKey || !phone.trim()) return
    setBusy(true)
    setErr('')
    try {
      await api.submitAuthInput(accountKey, phone)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  // 已拿到配对码：展示大号码 + 在手机上输入的指引
  if (pairingCode) {
    return (
      <div className="qr-panel">
        <div className="qr-card">
          <h2>{t('pair.title')}</h2>
          <div className="pairing-code">{pairingCode}</div>
          <ol>
            <li>{t('pair.step1')}</li>
            <li>{t('pair.step2')}</li>
            <li>{t('pair.step3')}</li>
          </ol>
          <p className="qr-hint">{t('pair.hint')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="qr-panel">
      <div className="qr-card">
        <h2>{t('qr.title')}</h2>

        <div className="login-tabs">
          <button
            type="button"
            className={mode === 'qr' ? 'on' : ''}
            onClick={() => setMode('qr')}
          >
            {t('qr.tabQr')}
          </button>
          <button
            type="button"
            className={mode === 'phone' ? 'on' : ''}
            onClick={() => setMode('phone')}
          >
            {t('qr.tabPhone')}
          </button>
        </div>

        {mode === 'qr' ? (
          <>
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
          </>
        ) : (
          <div className="phone-login">
            <label className="field">
              <span>{t('qr.phoneLabel')}</span>
              <input
                type="text"
                value={phone}
                placeholder="+8613800138000"
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void requestCode()
                }}
              />
            </label>
            <p className="field-hint">{t('qr.phoneHint')}</p>
            {err && <p className="auth-err">{err}</p>}
            <button
              type="button"
              className="primary-btn"
              disabled={busy || !phone.trim()}
              onClick={() => void requestCode()}
            >
              {busy ? '…' : t('qr.getCode')}
            </button>
          </div>
        )}

        <p className="qr-hint">{t('qr.hint')}</p>
      </div>
    </div>
  )
}
