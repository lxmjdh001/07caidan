import { useEffect, useRef, useState } from 'react'
import type { ChannelState } from '@shared/domain'
import type { ChannelPluginInfo } from '@shared/ipc'
import { LANGUAGES } from '@shared/langs'
import type { AccountConfig } from '@shared/settings'
import { useI18n } from '../i18n'

const api = window.omni

interface Props {
  accountKey: string
  plugin?: ChannelPluginInfo
  state: ChannelState | undefined
  config: AccountConfig
  onSave: (key: string, config: AccountConfig) => Promise<void>
  onLogout: (key: string) => Promise<void>
  /** 返回 true 表示账号已删除；失败时保留弹窗，便于用户看到错误后重试。 */
  onRemove: (key: string) => Promise<boolean>
  onClose: () => void
  focusProxy?: boolean
}

/** 单账号设置弹窗（凭证 / 备注名 / 默认客户语言 / 代理 / 退出 / 删除） */
export function AccountModal({
  accountKey,
  plugin,
  state,
  config,
  onSave,
  onLogout,
  onRemove,
  onClose,
  focusProxy = false
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const [label, setLabel] = useState(config.label ?? '')
  const [defaultLang, setDefaultLang] = useState(config.defaultLang ?? '')
  const [proxyUrl, setProxyUrl] = useState(config.proxyUrl ?? '')
  const [deviceLabel, setDeviceLabel] = useState(config.deviceLabel ?? '')
  const [creds, setCreds] = useState<Record<string, string>>(config.credentials ?? {})
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [authInput, setAuthInput] = useState('')
  const [authBusy, setAuthBusy] = useState(false)

  const [showAdvanced, setShowAdvanced] = useState(false)
  const proxyInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!focusProxy) return
    proxyInputRef.current?.focus()
    proxyInputRef.current?.scrollIntoView({ block: 'center' })
  }, [focusProxy])

  const isWhatsApp = plugin?.kind === 'whatsapp' || accountKey.startsWith('whatsapp:')
  const allCredFields = plugin?.credentialFields ?? []
  // 高级项（如 Telegram 的 api_id）默认折叠：软件已内置，普通用户不该看见
  const basicFields = allCredFields.filter((f) => !f.advanced)
  const advancedFields = allCredFields.filter((f) => f.advanced)
  const credFields = showAdvanced ? allCredFields : basicFields

  // Telegram 普通账号：多步交互登录（手机号 → 验证码 → 两步密码）
  const AUTH_STEP: Partial<Record<string, { labelKey: string; hintKey: string }>> = {
    waiting_phone: { labelKey: 'auth.tgPhone', hintKey: 'auth.tgPhoneHint' },
    waiting_code: { labelKey: 'auth.tgCode', hintKey: 'auth.tgCodeHint' },
    waiting_password: { labelKey: 'auth.tgPassword', hintKey: 'auth.tgPasswordHint' }
  }
  const authStep = state?.status ? AUTH_STEP[state.status] : undefined

  // phone_code 类平台同时支持扫码与手机号（Telegram 官方客户端默认扫码）
  const supportsQrLogin = plugin?.authType === 'phone_code'
  const loggedIn = state?.status === 'connected'
  const displayStatus = config.disabled
    ? 'disabled'
    : state?.status === 'connected'
      ? 'online'
      : state?.status === 'error'
        ? 'abnormal'
        : 'offline'
  const switchLogin = async (mode: 'qr' | 'phone'): Promise<void> => {
    setAuthBusy(true)
    try {
      await api.setLoginMode(accountKey, mode)
    } finally {
      setAuthBusy(false)
    }
  }

  const buildConfig = (): AccountConfig => ({
    label: label.trim() || undefined,
    defaultLang: defaultLang || undefined,
    proxyUrl: proxyUrl.trim() || undefined,
    deviceLabel: isWhatsApp ? deviceLabel.trim() || undefined : undefined,
    credentials: allCredFields.length > 0 ? creds : config.credentials
  })

  /** 需要「保存并连接」的平台：填凭证类与手机号验证码类 */
  const needsConnect = plugin?.authType === 'credentials' || plugin?.authType === 'phone_code'

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(accountKey, buildConfig())
      onClose()
    } finally {
      setSaving(false)
    }
  }

  /** 提交交互式登录输入；弹窗保持打开，状态会推进到下一步 */
  const submitAuth = async (): Promise<void> => {
    const value = authInput.trim()
    if (!value) return
    setAuthBusy(true)
    try {
      await api.submitAuthInput(accountKey, value)
      setAuthInput('')
    } finally {
      setAuthBusy(false)
    }
  }

  // 填凭证类：保存后立即连接。
  // 手机号验证码类（Telegram 普通账号）连接后还要在本弹窗里逐步填手机号/验证码/密码，
  // 所以不能关窗——关了用户就再也看不到下一步输入框。
  const saveAndConnect = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(accountKey, buildConfig())
      if (!config.disabled) await api.startChannel(accountKey)
      if (plugin?.authType !== 'phone_code') onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={(e) => e.stopPropagation()}>
        <h2>{t('account.settings')}</h2>
        <div className="account-block-head">
          <span className="account-name">
            {state?.selfName || t('account.notLoggedIn')}
          </span>
          <span className="account-key">{accountKey}</span>
          <span className="account-status">
            {t(`status.${displayStatus}` as 'status.online')}
          </span>
        </div>

        {supportsQrLogin && !loggedIn && (
          <>
            <div className="login-tabs">
              <button
                type="button"
                className={state?.status === 'waiting_qr' ? 'on' : ''}
                disabled={authBusy}
                onClick={() => void switchLogin('qr')}
              >
                {t('qr.tabQr')}
              </button>
              <button
                type="button"
                className={state?.status !== 'waiting_qr' ? 'on' : ''}
                disabled={authBusy}
                onClick={() => void switchLogin('phone')}
              >
                {t('qr.tabPhone')}
              </button>
            </div>
            {state?.status === 'waiting_qr' && (
              <div className="tg-qr">
                {state.qrDataUrl ? (
                  <img className="qr-img" src={state.qrDataUrl} alt="Telegram QR" />
                ) : (
                  <div className="qr-placeholder">{t('qr.waiting')}</div>
                )}
                <p className="field-hint">{state.detail || t('qr.tgHint')}</p>
              </div>
            )}
          </>
        )}

        {authStep && (
          <div className="auth-step">
            <label className="field">
              <span>{t(authStep.labelKey as 'auth.tgPhone')}</span>
              <input
                type={state?.status === 'waiting_password' ? 'password' : 'text'}
                value={authInput}
                autoFocus
                onChange={(e) => setAuthInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitAuth()
                }}
              />
            </label>
            <p className="field-hint">{state?.detail || t(authStep.hintKey as 'auth.tgPhoneHint')}</p>
            <button
              type="button"
              className="primary-btn"
              disabled={authBusy || !authInput.trim()}
              onClick={() => void submitAuth()}
            >
              {t('auth.tgSubmit')}
            </button>
          </div>
        )}

        {allCredFields.length > 0 && (
          <>
            {credFields.map((f) => (
              <label key={f.key} className="field">
                <span>{f.label}</span>
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={creds[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setCreds((prev) => ({ ...prev, [f.key]: e.target.value }))}
                />
              </label>
            ))}
            {state?.detail && <p className="field-hint">{state.detail}</p>}
            {advancedFields.length > 0 && !showAdvanced && (
              <button type="button" className="link-btn" onClick={() => setShowAdvanced(true)}>
                {t('account.advanced')}
              </button>
            )}
          </>
        )}

        <label className="field">
          <span>{t('account.label')}</span>
          <input
            ref={proxyInputRef}
            type="text"
            value={label}
            placeholder={state?.selfName ?? ''}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>

        <label className="field">
          <span>{t('settings.accountLang')}</span>
          <select value={defaultLang} onChange={(e) => setDefaultLang(e.target.value)}>
            <option value="">{t('settings.followGlobal')}</option>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t('settings.proxy')}</span>
          <input
            type="text"
            value={proxyUrl}
            placeholder="socks5://127.0.0.1:1080"
            onChange={(e) => setProxyUrl(e.target.value)}
          />
        </label>
        <p className="field-hint">{t('settings.proxyHint')}</p>

        {isWhatsApp && (
          <>
            <label className="field">
              <span>{t('account.device')}</span>
              <input
                type="text"
                value={deviceLabel}
                placeholder={t('account.deviceAuto')}
                onChange={(e) => setDeviceLabel(e.target.value)}
              />
            </label>
            <p className="field-hint">{t('account.deviceHint')}</p>
          </>
        )}

        <div className="account-actions">
          <button
            type="button"
            className="danger-btn"
            onClick={() => {
              if (window.confirm(t('settings.logoutConfirm'))) {
                void onLogout(accountKey)
                onClose()
              }
            }}
          >
            {t('settings.logout')}
          </button>
          <button
            type="button"
            className="danger-btn"
            disabled={removing}
            onClick={() => {
              if (window.confirm(t('settings.removeConfirm'))) {
                setRemoving(true)
                void onRemove(accountKey).then((removed) => {
                  if (removed) onClose()
                }).finally(() => setRemoving(false))
              }
            }}
          >
            {t('settings.removeAccount')}
          </button>
        </div>

        <footer className="modal-footer">
          <button type="button" className="ghost-btn" onClick={onClose}>
            {t('settings.cancel')}
          </button>
          {needsConnect ? (
            <button
              type="button"
              className="primary-btn"
              disabled={saving}
              onClick={() => void saveAndConnect()}
            >
              {t('account.saveConnect')}
            </button>
          ) : (
            <button
              type="button"
              className="primary-btn"
              disabled={saving}
              onClick={() => void save()}
            >
              {t('settings.save')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
