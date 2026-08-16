import { useState } from 'react'
import type { TranslatorInfo } from '@shared/ipc'
import type { AppSettings } from '@shared/settings'
import { dictionaries, useI18n } from '../i18n'

interface Props {
  settings: AppSettings
  translators: TranslatorInfo[]
  onSave: (patch: Partial<AppSettings>) => Promise<void>
  onLogoutWhatsApp: () => Promise<void>
  onClose: () => void
}

export function SettingsModal({
  settings,
  translators,
  onSave,
  onLogoutWhatsApp,
  onClose
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const [locale, setLocale] = useState(settings.locale)
  const [engine, setEngine] = useState(settings.translation.engine)
  const [inbound, setInbound] = useState(settings.translation.inboundEnabled)
  const [displayLang, setDisplayLang] = useState(settings.translation.displayLang)
  const [customUrl, setCustomUrl] = useState(settings.translation.custom.url)
  const [customKey, setCustomKey] = useState(settings.translation.custom.apiKey)
  const [proxyUrl, setProxyUrl] = useState(settings.accounts['whatsapp:main']?.proxyUrl ?? '')
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({
        locale,
        translation: {
          engine,
          inboundEnabled: inbound,
          outboundEnabled: settings.translation.outboundEnabled,
          displayLang,
          custom: { url: customUrl.trim(), apiKey: customKey.trim() }
        },
        accounts: {
          ...settings.accounts,
          'whatsapp:main': { proxyUrl: proxyUrl.trim() || undefined }
        }
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('settings.title')}</h2>

        <section>
          <h3>{t('settings.general')}</h3>
          <label className="field">
            <span>{t('settings.locale')}</span>
            <select value={locale} onChange={(e) => setLocale(e.target.value)}>
              {Object.keys(dictionaries).map((loc) => (
                <option key={loc} value={loc}>
                  {loc === 'zh-CN' ? '简体中文' : 'English'}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section>
          <h3>{t('settings.translation')}</h3>
          <label className="field">
            <span>{t('settings.engine')}</span>
            <select value={engine} onChange={(e) => setEngine(e.target.value)}>
              {translators.map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {tr.displayName}
                </option>
              ))}
            </select>
          </label>
          <p className="field-hint">{t('settings.engine.hint')}</p>
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={inbound}
              onChange={(e) => setInbound(e.target.checked)}
            />
            <span>{t('settings.inbound')}</span>
          </label>
          <label className="field">
            <span>{t('settings.displayLang')}</span>
            <select value={displayLang} onChange={(e) => setDisplayLang(e.target.value)}>
              <option value="zh-CN">简体中文</option>
              <option value="zh-TW">繁體中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
              <option value="es">Español</option>
              <option value="pt">Português</option>
            </select>
          </label>
          {engine === 'custom-http' && (
            <>
              <label className="field">
                <span>{t('settings.customUrl')}</span>
                <input
                  type="text"
                  value={customUrl}
                  placeholder="https://example.com/translate"
                  onChange={(e) => setCustomUrl(e.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('settings.customKey')}</span>
                <input
                  type="password"
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                />
              </label>
              <p className="field-hint">{t('settings.customHint')}</p>
            </>
          )}
        </section>

        <section>
          <h3>{t('settings.account')}</h3>
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
          <button
            type="button"
            className="danger-btn"
            onClick={() => {
              if (window.confirm(t('settings.logoutConfirm'))) {
                void onLogoutWhatsApp()
                onClose()
              }
            }}
          >
            {t('settings.logout')}
          </button>
        </section>

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
