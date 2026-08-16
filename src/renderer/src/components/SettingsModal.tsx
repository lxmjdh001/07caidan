import { useState } from 'react'
import type { TranslatorInfo } from '@shared/ipc'
import { LANGUAGES } from '@shared/langs'
import type { AppSettings } from '@shared/settings'
import { dictionaries, useI18n } from '../i18n'

interface Props {
  settings: AppSettings
  translators: TranslatorInfo[]
  onSave: (patch: Partial<AppSettings>) => Promise<void>
  onClose: () => void
}

function LangSelect({
  value,
  onChange,
  allowEmpty
}: {
  value: string
  onChange: (v: string) => void
  /** 传入 label 时增加一个空值选项（如"跟随全局"） */
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

export function SettingsModal({
  settings,
  translators,
  onSave,
  onClose
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const tr = settings.translation
  const [locale, setLocale] = useState(settings.locale)
  const [engine, setEngine] = useState(tr.engine)
  const [inbound, setInbound] = useState(tr.inboundEnabled)
  const [outbound, setOutbound] = useState(tr.outboundEnabled)
  const [confirmSend, setConfirmSend] = useState(tr.confirmBeforeSend)
  const [syncEnabled, setSyncEnabled] = useState(settings.sync.enabled)
  const [syncUrl, setSyncUrl] = useState(settings.sync.serverUrl)
  const [syncToken, setSyncToken] = useState(settings.sync.token)
  const [syncMedia, setSyncMedia] = useState(settings.sync.uploadMedia)
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

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({
        locale,
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
        sync: {
          enabled: syncEnabled,
          serverUrl: syncUrl.trim(),
          token: syncToken.trim(),
          uploadMedia: syncMedia
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
              <input type="password" value={deeplKey} onChange={(e) => setDeeplKey(e.target.value)} />
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
                <input type="password" value={llmKey} onChange={(e) => setLlmKey(e.target.value)} />
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
            <input type="checkbox" checked={inbound} onChange={(e) => setInbound(e.target.checked)} />
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

        <section>
          <h3>{t('settings.sync')}</h3>
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={syncEnabled}
              onChange={(e) => setSyncEnabled(e.target.checked)}
            />
            <span>{t('settings.syncEnabled')}</span>
          </label>
          {syncEnabled && (
            <>
              <label className="field">
                <span>{t('settings.syncUrl')}</span>
                <input
                  type="text"
                  value={syncUrl}
                  placeholder="https://api.example.com"
                  onChange={(e) => setSyncUrl(e.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('settings.syncToken')}</span>
                <input
                  type="password"
                  value={syncToken}
                  onChange={(e) => setSyncToken(e.target.value)}
                />
              </label>
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={syncMedia}
                  onChange={(e) => setSyncMedia(e.target.checked)}
                />
                <span>{t('settings.syncMedia')}</span>
              </label>
              <p className="field-hint">{t('settings.syncHint')}</p>
            </>
          )}
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
