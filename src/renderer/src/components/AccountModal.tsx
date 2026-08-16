import { useState } from 'react'
import type { ChannelState } from '@shared/domain'
import { LANGUAGES } from '@shared/langs'
import type { AccountConfig } from '@shared/settings'
import { useI18n } from '../i18n'

interface Props {
  accountKey: string
  state: ChannelState | undefined
  config: AccountConfig
  onSave: (key: string, config: AccountConfig) => Promise<void>
  onLogout: (key: string) => Promise<void>
  onRemove: (key: string) => Promise<void>
  onClose: () => void
}

/** 单账号设置弹窗（备注名 / 默认客户语言 / 代理 / 退出 / 删除） */
export function AccountModal({
  accountKey,
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
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(accountKey, {
        label: label.trim() || undefined,
        defaultLang: defaultLang || undefined,
        proxyUrl: proxyUrl.trim() || undefined,
        deviceLabel: deviceLabel.trim() || undefined
      })
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
          <button type="button" className="primary-btn" disabled={saving} onClick={() => void save()}>
            {t('settings.save')}
          </button>
        </footer>
      </div>
    </div>
  )
}
