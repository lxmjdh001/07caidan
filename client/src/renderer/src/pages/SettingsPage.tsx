import { useState } from 'react'
import type { TranslatorInfo } from '@shared/ipc'
import { LANGUAGES } from '@shared/langs'
import type { AppSettings, ThemeMode } from '@shared/settings'
import { LOCALES, useI18n } from '../i18n'

interface Props {
  settings: AppSettings
  translators: TranslatorInfo[]
  onSave: (patch: Partial<AppSettings>) => Promise<void>
  onAccountLogout: () => Promise<void>
}

/** 设置分类；后续新增设置直接加 tab，不必再往一个长表单里塞 */
type Tab = 'general' | 'translation' | 'platform' | 'backend'

function LangSelect({
  value,
  onChange,
  allowEmpty
}: {
  value: string
  onChange: (v: string) => void
  allowEmpty?: string
}): React.JSX.Element {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  )
}

export function SettingsPage({
  settings,
  translators,
  onSave,
  onAccountLogout
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const tr = settings.translation
  const [tab, setTab] = useState<Tab>('general')
  const [locale, setLocale] = useState(settings.locale)
  const [theme, setTheme] = useState<ThemeMode>(settings.theme)
  const [notifyOn, setNotifyOn] = useState(settings.notifications.enabled)
  const [notifyPreview, setNotifyPreview] = useState(settings.notifications.showPreview)
  const [notifySound, setNotifySound] = useState(settings.notifications.sound)
  const [engine, setEngine] = useState(tr.engine)
  const [inbound, setInbound] = useState(tr.inboundEnabled)
  const [outbound, setOutbound] = useState(tr.outboundEnabled)
  const [confirmSend, setConfirmSend] = useState(tr.confirmBeforeSend)
  const [syncMedia, setSyncMedia] = useState(settings.sync.uploadMedia)
  const [tgApiId, setTgApiId] = useState(settings.platform.telegramApiId)
  const [tgApiHash, setTgApiHash] = useState(settings.platform.telegramApiHash)
  const [displayLang, setDisplayLang] = useState(tr.displayLang)
  const [targetLangDefault, setTargetLangDefault] = useState(tr.targetLangDefault)
  const [customUrl, setCustomUrl] = useState(tr.custom.url)
  const [customKey, setCustomKey] = useState(tr.custom.apiKey)
  const [deeplKey, setDeeplKey] = useState(tr.deepl.apiKey)
  const [gcKey, setGcKey] = useState(tr.googleCloud.apiKey)
  const [llmBaseUrl, setLlmBaseUrl] = useState(tr.llm.baseUrl)
  const [llmKey, setLlmKey] = useState(tr.llm.apiKey)
  const [llmModel, setLlmModel] = useState(tr.llm.model)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({
        locale,
        theme,
        notifications: { enabled: notifyOn, showPreview: notifyPreview, sound: notifySound },
        translation: {
          engine,
          inboundEnabled: inbound,
          outboundEnabled: outbound,
          confirmBeforeSend: confirmSend,
          displayLang,
          targetLangDefault,
          custom: { url: customUrl.trim(), apiKey: customKey.trim() },
          deepl: { apiKey: deeplKey.trim() },
          googleCloud: { apiKey: gcKey.trim() },
          llm: { baseUrl: llmBaseUrl.trim(), apiKey: llmKey.trim(), model: llmModel.trim() }
        },
        sync: { ...settings.sync, uploadMedia: syncMedia },
        platform: { telegramApiId: tgApiId.trim(), telegramApiHash: tgApiHash.trim() }
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
    } finally {
      setSaving(false)
    }
  }

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'general', label: t('settings.general') },
    { id: 'translation', label: t('settings.translation') },
    { id: 'platform', label: t('settings.platform') },
    { id: 'backend', label: t('settings.account') }
  ]

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('settings.title')}</h1>
        <div className="page-tabs">
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              className={tab === x.id ? 'on' : ''}
              onClick={() => setTab(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>
      </header>

      <div className="page-body">
        <div className="form-page">
          {tab === 'general' && (
            <section className="form-card">
              <h3>{t('settings.general')}</h3>
              <label className="field">
                <span>{t('settings.locale')}</span>
                <select value={locale} onChange={(e) => setLocale(e.target.value)}>
                  <option value="auto">{t('settings.localeAuto')}</option>
                  {LOCALES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.nativeName}
                    </option>
                  ))}
                </select>
              </label>
              <p className="field-hint">{t('settings.localeHint')}</p>

              <div className="field">
                <span>{t('settings.theme')}</span>
                <div className="radio-row">
                  {(['system', 'light', 'dark'] as ThemeMode[]).map((m) => (
                    <label key={m} className="radio-item">
                      <input
                        type="radio"
                        checked={theme === m}
                        onChange={() => setTheme(m)}
                      />
                      <span>{t(`settings.theme.${m}` as 'settings.theme.system')}</span>
                    </label>
                  ))}
                </div>
              </div>
              <p className="field-hint">{t('settings.themeHint')}</p>

              <h3 style={{ marginTop: 22 }}>{t('settings.notifications')}</h3>
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={notifyOn}
                  onChange={(e) => setNotifyOn(e.target.checked)}
                />
                <span>{t('settings.notifyEnabled')}</span>
              </label>
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={notifyPreview}
                  disabled={!notifyOn}
                  onChange={(e) => setNotifyPreview(e.target.checked)}
                />
                <span>{t('settings.notifyPreview')}</span>
              </label>
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={notifySound}
                  disabled={!notifyOn}
                  onChange={(e) => setNotifySound(e.target.checked)}
                />
                <span>{t('settings.notifySound')}</span>
              </label>
              <p className="field-hint">{t('settings.notifyHint')}</p>
            </section>
          )}

          {tab === 'translation' && (
            <section className="form-card">
              <h3>{t('settings.translation')}</h3>
              <label className="field">
                <span>{t('settings.engine')}</span>
                <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                  {translators.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <p className="field-hint">{t('settings.engine.hint')}</p>

              {engine === 'deepl' && (
                <label className="field">
                  <span>{t('settings.deeplKey')}</span>
                  <input
                    type="password"
                    value={deeplKey}
                    onChange={(e) => setDeeplKey(e.target.value)}
                  />
                </label>
              )}
              {engine === 'google-cloud' && (
                <label className="field">
                  <span>{t('settings.gcKey')}</span>
                  <input type="password" value={gcKey} onChange={(e) => setGcKey(e.target.value)} />
                </label>
              )}
              {engine === 'llm' && (
                <>
                  <label className="field">
                    <span>{t('settings.llmBaseUrl')}</span>
                    <input
                      type="text"
                      value={llmBaseUrl}
                      placeholder="https://api.openai.com/v1"
                      onChange={(e) => setLlmBaseUrl(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>{t('settings.llmKey')}</span>
                    <input
                      type="password"
                      value={llmKey}
                      onChange={(e) => setLlmKey(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>{t('settings.llmModel')}</span>
                    <input
                      type="text"
                      value={llmModel}
                      placeholder="claude-haiku-4-5-20251001 / gpt-4o-mini …"
                      onChange={(e) => setLlmModel(e.target.value)}
                    />
                  </label>
                </>
              )}
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

              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={inbound}
                  onChange={(e) => setInbound(e.target.checked)}
                />
                <span>{t('settings.inbound')}</span>
              </label>
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={outbound}
                  onChange={(e) => setOutbound(e.target.checked)}
                />
                <span>{t('settings.outbound')}</span>
              </label>
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={confirmSend}
                  onChange={(e) => setConfirmSend(e.target.checked)}
                />
                <span>{t('settings.confirmBeforeSend')}</span>
              </label>
              <label className="field">
                <span>{t('settings.displayLang')}</span>
                <LangSelect value={displayLang} onChange={setDisplayLang} />
              </label>
              <label className="field">
                <span>{t('settings.targetLangDefault')}</span>
                <LangSelect value={targetLangDefault} onChange={setTargetLangDefault} />
              </label>
            </section>
          )}

          {tab === 'platform' && (
            <section className="form-card">
              <h3>{t('settings.platform')}</h3>
              <label className="field">
                <span>{t('settings.tgApiId')}</span>
                <input type="text" value={tgApiId} onChange={(e) => setTgApiId(e.target.value)} />
              </label>
              <label className="field">
                <span>{t('settings.tgApiHash')}</span>
                <input
                  type="password"
                  value={tgApiHash}
                  onChange={(e) => setTgApiHash(e.target.value)}
                />
              </label>
              <p className="field-hint">{t('settings.tgApiHint')}</p>
            </section>
          )}

          {tab === 'backend' && (
            <section className="form-card">
              <h3>{t('settings.account')}</h3>
              <div className="account-block-head">
                <span className="account-name">
                  {settings.sync.email || t('account.notLoggedIn')}
                </span>
                <span className="account-key">{settings.sync.serverUrl}</span>
              </div>
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={syncMedia}
                  onChange={(e) => setSyncMedia(e.target.checked)}
                />
                <span>{t('settings.syncMedia')}</span>
              </label>
              <p className="field-hint">{t('settings.syncHint')}</p>
              <button
                type="button"
                className="danger-btn"
                onClick={() => {
                  if (window.confirm(t('auth.logoutConfirm'))) void onAccountLogout()
                }}
              >
                {t('auth.logout')}
              </button>
            </section>
          )}
        </div>
      </div>

      <footer className="page-footer">
        {saved && <span className="save-ok">{t('settings.saved')}</span>}
        <button type="button" className="primary-btn" disabled={saving} onClick={() => void save()}>
          {t('settings.save')}
        </button>
      </footer>
    </div>
  )
}
