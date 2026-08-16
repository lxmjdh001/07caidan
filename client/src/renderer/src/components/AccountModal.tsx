import { useState } from 'react'
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
  onRemove: (key: string) => Promise<void>
  onClose: () => void
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
  onClose
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const [label, setLabel] = useState(config.label ?? '')
  const [defaultLang, setDefaultLang] = useState(config.defaultLang ?? '')
  const [proxyUrl, setProxyUrl] = useState(config.proxyUrl ?? '')
  const [deviceLabel, setDeviceLabel] = useState(config.deviceLabel ?? '')
  const [creds, setCreds] = useState<Record<string, string>>(config.credentials ?? {})
  const [saving, setSaving] = useState(false)

  const isWhatsApp = plugin?.kind === 'whatsapp' || accountKey.startsWith('whatsapp:')
  const credFields = plugin?.credentialFields ?? []

  const buildConfig = (): AccountConfig => ({
    label: label.trim() || undefined,
    defaultLang: defaultLang || undefined,
    proxyUrl: proxyUrl.trim() || undefined,
    deviceLabel: isWhatsApp ? deviceLabel.trim() || undefined : undefined,
    credentials: credFields.length > 0 ? creds : config.credentials
  })

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(accountKey, buildConfig())
      onClose()
    } finally {
      setSaving(false)
    }
  }

  // 填凭证类：保存后立即连接
  const saveAndConnect = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(accountKey, buildConfig())
      await api.startChannel(accountKey)
      onClose()
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
            {t(`status.${state?.status ?? 'stopped'}` as 'status.stopped')}
          </span>
        </div>

        {credFields.length > 0 && (
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
          </>
        )}

        <label className="field">
          <span>{t('account.label')}</span>
          <input
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
          {accountKey !== 'whatsapp:main' && (
            <button
              type="button"
              className="danger-btn"
              onClick={() => {
                if (window.confirm(t('settings.removeConfirm'))) {
                  void onRemove(accountKey)
                  onClose()
                }
              }}
            >
              {t('settings.removeAccount')}
            </button>
          )}
        </div>

        <footer className="modal-footer">
          <button type="button" className="ghost-btn" onClick={onClose}>
            {t('settings.cancel')}
          </button>
          {credFields.length > 0 ? (
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
