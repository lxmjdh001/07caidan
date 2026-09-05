import { useEffect, useState } from 'react'
import type { ChannelKind, ChannelStatus } from '@shared/domain'
import { errText } from '../errors'
import { useI18n } from '../i18n'

const api = window.omni

interface Props {
  /** 当前等待登录的账号 key（提交手机号用） */
  accountKey?: string
  qrDataUrl?: string
  kind?: ChannelKind
  /** LINE 扫码后显示在桌面端、需填回手机的临时 PIN */
  verificationCode?: string
  /** 已申请到的配对码；有值时展示配对码流程 */
  pairingCode?: string
  /** 当前登录步骤；Telegram 扫码后可能继续要求验证码或两步验证密码 */
  status?: ChannelStatus
  /** 主进程给出的当前步骤说明 */
  detail?: string
}

/** 登录面板：扫码、手机号、验证码和两步密码全部在主聊天区域内完成。 */
export function QrPanel({
  accountKey,
  qrDataUrl,
  pairingCode,
  kind,
  verificationCode,
  status,
  detail
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const isLine = kind === 'line'
  const isTelegram = kind === 'telegram'
  const isKakaoTalk = kind === 'kakaotalk'
  const [mode, setMode] = useState<'qr' | 'phone'>('qr')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [authInput, setAuthInput] = useState('')

  useEffect(() => {
    setAuthInput('')
    setErr('')
  }, [status])

  useEffect(() => {
    if (!isTelegram) return
    if (status === 'waiting_qr') setMode('qr')
    if (status === 'waiting_phone' || status === 'waiting_code') setMode('phone')
  }, [isTelegram, status])

  const telegramAuthStep = isTelegram && (
    status === 'waiting_phone' || status === 'waiting_code' || status === 'waiting_password'
  )

  const telegramAuthLabel = status === 'waiting_phone'
    ? t('auth.tgPhone')
    : status === 'waiting_code'
      ? t('auth.tgCode')
      : t('auth.tgPassword')

  const telegramAuthHint = status === 'waiting_phone'
    ? t('auth.tgPhoneHint')
    : status === 'waiting_code'
      ? t('auth.tgCodeHint')
      : t('auth.tgPasswordHint')

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

  const submitTelegramAuth = async (): Promise<void> => {
    if (!accountKey || !authInput.trim()) return
    setBusy(true)
    setErr('')
    try {
      await api.submitAuthInput(accountKey, authInput.trim())
      setAuthInput('')
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const switchLoginMode = (next: 'qr' | 'phone'): void => {
    setMode(next)
    setErr('')
    if (!isTelegram || !accountKey) return
    void api.setLoginMode(accountKey, next).catch((e) => setErr(errText(e)))
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

  if (isKakaoTalk && verificationCode) {
    return (
      <div className="qr-panel">
        <div className="qr-card">
          <h2>登录 KakaoTalk</h2>
          <section className="kakao-device-prompt" aria-live="assertive">
            <span>手机 KakaoTalk 正在等待设备验证</span>
            <strong>{verificationCode}</strong>
            <p>请在手机 KakaoTalk 的设备验证页面输入这 8 位验证码并确认。</p>
          </section>
          <p className="qr-hint">验证完成后会自动连接并同步会话，无需再次点击。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="qr-panel">
      <div className="qr-card">
        <h2>{isLine ? '登录 LINE' : isTelegram ? 'Telegram' : t('qr.title')}</h2>

        {!isLine && <div className="login-tabs">
          <button
            type="button"
            className={mode === 'qr' ? 'on' : ''}
            onClick={() => switchLoginMode('qr')}
          >
            {t('qr.tabQr')}
          </button>
          <button
            type="button"
            className={mode === 'phone' ? 'on' : ''}
            onClick={() => switchLoginMode('phone')}
          >
            {isTelegram ? `${t('qr.tabPhone')} · ${t('auth.tgCode')}` : t('qr.tabPhone')}
          </button>
        </div>}

        {telegramAuthStep ? (
          <section className="telegram-auth-prompt" aria-live="assertive">
            <strong>{telegramAuthLabel}</strong>
            <p>{detail || telegramAuthHint}</p>
            {status === 'waiting_password' && detail !== telegramAuthHint && (
              <p className="telegram-auth-note">{telegramAuthHint}</p>
            )}
            <label className="field">
              <span>{telegramAuthLabel}</span>
              <input
                type={status === 'waiting_password' ? 'password' : 'text'}
                value={authInput}
                autoFocus
                autoComplete={status === 'waiting_password' ? 'current-password' : 'one-time-code'}
                inputMode={status === 'waiting_code' ? 'numeric' : undefined}
                onChange={(e) => setAuthInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitTelegramAuth()
                }}
              />
            </label>
            {err && <p className="auth-err">{err}</p>}
            <button
              type="button"
              className="primary-btn"
              disabled={busy || !authInput.trim()}
              onClick={() => void submitTelegramAuth()}
            >
              {busy ? '…' : t('auth.tgSubmit')}
            </button>
          </section>
        ) : (isLine || isTelegram || mode === 'qr') ? (
          <>
            {isLine && verificationCode && (
              <section className="line-pin-prompt" aria-live="assertive">
                <span>手机 LINE 正在要求验证码</span>
                <strong>{verificationCode}</strong>
                <p>请在手机的“输入验证码”页面填写这 6 位 PIN，再点击验证。</p>
              </section>
            )}
            {!isTelegram && <ol>
              {isLine ? (
                <>
                  <li>在手机上打开 LINE</li>
                  <li>打开“扫描二维码”</li>
                  <li>扫描下方二维码并在手机上确认</li>
                </>
              ) : (
                <>
                  <li>{t('qr.step1')}</li>
                  <li>{t('qr.step2')}</li>
                  <li>{t('qr.step3')}</li>
                </>
              )}
            </ol>}
            {qrDataUrl ? (
              <img
                className="qr-img"
                src={qrDataUrl}
                alt={isLine ? 'LINE QR' : isTelegram ? 'Telegram QR' : 'WhatsApp QR'}
              />
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

        {!telegramAuthStep && <p className="qr-hint">
          {isLine
            ? '登录和会话仅保存在此设备的该 LINE 账号目录中。'
            : isTelegram
              ? t('qr.tgHint')
              : t('qr.hint')}
        </p>}
      </div>
    </div>
  )
}
