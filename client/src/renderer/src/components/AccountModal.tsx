import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Globe2, PencilLine, ShieldCheck, X } from 'lucide-react'
import type { ChannelState } from '@shared/domain'
import type { ChannelPluginInfo } from '@shared/ipc'
import { LANGUAGES } from '@shared/langs'
import type { AccountConfig, AppSettings } from '@shared/settings'
import {
  composeProxyUrl,
  PROXY_PROTOCOL_OPTIONS,
  splitProxyInput,
  type ProxyProtocol
} from '@shared/proxy-input'
import { useI18n } from '../i18n'
import { errText } from '../errors'

const api = window.omni

interface Props {
  accountKey: string
  plugin?: ChannelPluginInfo
  state: ChannelState | undefined
  config: AccountConfig
  onSave: (key: string, config: AccountConfig) => Promise<void>
  onSettings: (settings: AppSettings) => void
  onLogout: (key: string) => Promise<void>
  /** 返回 true 表示账号已删除；失败时保留弹窗，便于用户看到错误后重试。 */
  onRemove: (key: string) => Promise<boolean>
  onClose: () => void
  /** true 为独立代理配置；false 为账号资料编辑。两个入口不混用字段。 */
  focusProxy?: boolean
}

/** 单账号弹窗：编辑账号资料与代理配置使用两个完全独立的界面。 */
export function AccountModal({
  accountKey,
  plugin,
  state,
  config,
  onSave,
  onSettings,
  onLogout,
  onRemove,
  onClose,
  focusProxy = false
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const initialProxy = splitProxyInput(config.proxyUrl)
  const [label, setLabel] = useState(config.label ?? '')
  const [defaultLang, setDefaultLang] = useState(config.defaultLang ?? '')
  const [proxyProtocol, setProxyProtocol] = useState<ProxyProtocol>(initialProxy.protocol)
  const [proxyAddress, setProxyAddress] = useState(initialProxy.address)
  const [deviceLabel, setDeviceLabel] = useState(config.deviceLabel ?? '')
  const [creds, setCreds] = useState<Record<string, string>>(config.credentials ?? {})
  const [saving, setSaving] = useState(false)
  const [testingProxy, setTestingProxy] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [actionError, setActionError] = useState('')
  const [candidateProbe, setCandidateProbe] = useState<{ exitIp?: string; latencyMs: number; target: string } | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const isWhatsApp = plugin?.kind === 'whatsapp' || accountKey.startsWith('whatsapp:')
  const isKakaoTalk = plugin?.kind === 'kakaotalk' || accountKey.startsWith('kakaotalk:')
  const isOAuth = plugin?.authType === 'oauth'
  // Telegram 普通账号的扫码、手机号、验证码和两步密码统一在主聊天区完成。
  const allCredFields = plugin?.authType === 'phone_code' ? [] : plugin?.credentialFields ?? []
  const basicFields = allCredFields.filter((field) => !field.advanced)
  const advancedFields = allCredFields.filter((field) => field.advanced)
  const credFields = showAdvanced ? allCredFields : basicFields
  const loggedIn = state?.status === 'connected'
  const kakaoAuthenticating = isKakaoTalk && (
    state?.status === 'connecting' || state?.status === 'waiting_device_approval'
  )

  // Kakao 密码只用于首次换取设备会话；认证开始后以主进程保存的新会话凭证为准。
  useEffect(() => {
    if (!isKakaoTalk) return
    setCreds(config.credentials ?? {})
  }, [config.credentials, isKakaoTalk])

  const displayStatus = config.disabled
    ? 'disabled'
    : state?.status === 'connected'
      ? 'online'
      : state?.status === 'error'
        ? 'abnormal'
        : 'offline'
  const displayName = config.label || state?.selfName || t('account.notLoggedIn')
  const accountCaption = plugin?.displayName ? `${plugin.displayName} · ${accountKey}` : accountKey

  const buildDetailsConfig = (): AccountConfig => {
    const next: AccountConfig = {
      ...config,
      label: label.trim() || undefined,
      defaultLang: defaultLang || undefined,
      deviceLabel: isWhatsApp ? deviceLabel.trim() || undefined : config.deviceLabel
    }
    // 已登录的 Kakao 会话令牌由主进程维护，普通资料保存不能用旧密码覆盖它。
    if (!isKakaoTalk || !loggedIn) {
      next.credentials = allCredFields.length > 0 ? creds : config.credentials
    }
    return next
  }

  const requireConfiguredProxy = (): void => {
    if (!config.proxyUrl) throw new Error(t('account.configureProxyFirst'))
  }

  /** 账号编辑只保存资料，不检测、修改或清空代理配置。 */
  const saveDetails = async (): Promise<void> => {
    setSaving(true)
    setActionError('')
    try {
      await onSave(accountKey, buildDetailsConfig())
      onClose()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  /** 凭证类平台保存账号资料后，从原有独立代理启动登录。 */
  const saveDetailsAndConnect = async (): Promise<void> => {
    setSaving(true)
    setActionError('')
    try {
      await onSave(accountKey, buildDetailsConfig())
      requireConfiguredProxy()
      if (!config.disabled) await api.startChannel(accountKey)
      if (!isKakaoTalk) onClose()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  /** Meta 授权仍在官方页面完成；编辑页不再夹带代理表单。 */
  const authorize = async (): Promise<void> => {
    setSaving(true)
    setActionError('')
    try {
      await onSave(accountKey, buildDetailsConfig())
      requireConfiguredProxy()
      await api.beginOAuth(accountKey)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  /** 代理入口只处理网络：检测代理连通性、保存配置，并通过门禁重连账号。 */
  const testProxy = async (): Promise<void> => {
    const proxyUrl = composeProxyUrl(proxyProtocol, proxyAddress)
    if (!proxyUrl) {
      setActionError(t('account.proxyRequired'))
      return
    }
    setTestingProxy(true)
    setActionError('')
    setCandidateProbe(null)
    try {
      const probe = await api.testAccountProxy(accountKey, proxyUrl)
      setCandidateProbe({ exitIp: probe.exitIp, latencyMs: probe.latencyMs, target: probe.target })
    } catch {
      // 底层握手错误不直接暴露给客户，检测失败统一展示网络状态。
      setActionError(t('account.networkError'))
    } finally {
      setTestingProxy(false)
    }
  }

  const saveProxyAndConnect = async (): Promise<void> => {
    const proxyUrl = composeProxyUrl(proxyProtocol, proxyAddress)
    if (!proxyUrl) {
      setActionError(t('account.proxyRequired'))
      return
    }
    setSaving(true)
    setActionError('')
    try {
      const reuseCurrentAsset = Boolean(config.proxyId && proxyUrl === config.proxyUrl)
      const result = await api.configureAccountNetwork(accountKey, {
        proxyUrl,
        proxyId: reuseCurrentAsset ? config.proxyId : undefined,
        connect: true,
        skipTest: true
      })
      onSettings(result.settings)
      if (result.connectionError) {
        setActionError(t('account.networkError'))
        return
      }
      onClose()
    } catch (error) {
      setActionError(errText(error))
    } finally {
      setSaving(false)
    }
  }

  const identity = (
    <div className="account-modal-identity">
      <div className="account-modal-identity-copy">
        <strong>{displayName}</strong>
        <span title={accountKey}>{accountCaption}</span>
      </div>
      <span className={`account-modal-status is-${displayStatus}`}>
        {t(`status.${displayStatus}` as 'status.online')}
      </span>
    </div>
  )

  if (focusProxy) {
    const working = saving || testingProxy

    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div
          className="modal modal-narrow account-settings-modal proxy-config-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="proxy-config-title"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="account-modal-header">
            <div className="account-modal-title">
              <span className="account-modal-title-icon"><Globe2 size={21} /></span>
              <div>
                <h2 id="proxy-config-title">{t('account.proxyConfig')}</h2>
                <p>{t('account.proxySubtitle')}</p>
              </div>
            </div>
            <button type="button" className="account-modal-close" aria-label={t('settings.cancel')} onClick={onClose}>
              <X size={19} />
            </button>
          </header>

          <div className="account-modal-body">
            {identity}

            <label className="field proxy-config-field">
              <span>{t('account.proxyServer')}</span>
              <div className="proxy-config-row">
                <div className="proxy-config-input">
                  <select
                    className="proxy-config-protocol"
                    value={proxyProtocol}
                    disabled={working}
                    onChange={(event) => {
                      setProxyProtocol(event.target.value as ProxyProtocol)
                      setActionError('')
                      setCandidateProbe(null)
                    }}
                  >
                    {PROXY_PROTOCOL_OPTIONS.map((protocol) => (
                      <option key={protocol} value={protocol}>{protocol.toUpperCase()}</option>
                    ))}
                  </select>
                  <input
                    autoFocus
                    type="text"
                    value={proxyAddress}
                    disabled={working}
                    placeholder={t('account.proxyPlaceholder')}
                    spellCheck={false}
                    onChange={(event) => {
                      setProxyAddress(event.target.value)
                      setActionError('')
                      setCandidateProbe(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void testProxy()
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="ghost-btn proxy-inline-test-button"
                  disabled={working || !proxyAddress.trim()}
                  onClick={() => void testProxy()}
                >
                  <ShieldCheck size={16} />
                  {testingProxy ? t('account.proxyTesting') : t('account.proxyTestShort')}
                </button>
              </div>
            </label>
            <p className="proxy-config-hint">{t('account.proxyProtocols')}</p>

            {candidateProbe && (
              <div className="proxy-inline-result is-success" aria-live="polite">
                <CircleCheck size={16} />
                <span>
                  {t('account.proxyAvailable')} · {candidateProbe.target}
                  {candidateProbe.exitIp ? ` · ${t('account.proxyExit')} ${candidateProbe.exitIp}` : ''}
                  {' · '}{candidateProbe.latencyMs} ms
                </span>
              </div>
            )}
            {actionError && (
              <div className="proxy-inline-result is-error" aria-live="assertive">
                <CircleAlert size={16} />
                <span>{actionError}</span>
              </div>
            )}
          </div>

          <footer className="account-modal-footer">
            <button type="button" className="ghost-btn" disabled={working} onClick={onClose}>
              {t('settings.cancel')}
            </button>
            <button
              type="button"
              className="primary-btn"
              disabled={working || !proxyAddress.trim()}
              onClick={() => void saveProxyAndConnect()}
            >
              {saving ? t('account.proxySaving') : t('account.saveConnect')}
            </button>
          </footer>
        </div>
      </div>
    )
  }

  const needsCredentialConnect = !loggedIn && plugin?.authType === 'credentials' && allCredFields.length > 0

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-narrow account-settings-modal account-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="account-modal-header">
          <div className="account-modal-title">
            <span className="account-modal-title-icon"><PencilLine size={20} /></span>
            <div>
              <h2 id="account-settings-title">{t('account.settings')}</h2>
              <p>{t('account.editSubtitle')}</p>
            </div>
          </div>
          <button type="button" className="account-modal-close" aria-label={t('settings.cancel')} onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        <div className="account-modal-body">
          {identity}

          {isKakaoTalk && state?.status === 'waiting_device_approval' && state.verificationCode && (
            <div className="kakao-device-prompt" aria-live="assertive">
              <span>手机 KakaoTalk 正在等待设备验证</span>
              <strong>{state.verificationCode}</strong>
              <p>请在手机 KakaoTalk 显示的设备验证页面输入这 8 位验证码并确认。本码只用于当前登录。</p>
            </div>
          )}

          {isOAuth && !loggedIn && (
            <div className={`meta-oauth-prompt ${state?.status === 'error' ? 'is-error' : ''}`} aria-live="polite">
              <strong>{plugin?.displayName}</strong>
              <p>{state?.detail || t('account.oauthHint')}</p>
            </div>
          )}

          <div className="account-edit-fields">
            {allCredFields.length > 0 && (!isKakaoTalk || (!loggedIn && !kakaoAuthenticating)) && (
              <>
                {credFields.map((field) => (
                  <label key={field.key} className="field">
                    <span>{field.label}</span>
                    <input
                      type={field.secret ? 'password' : 'text'}
                      value={creds[field.key] ?? ''}
                      placeholder={field.placeholder}
                      onChange={(event) => setCreds((current) => ({ ...current, [field.key]: event.target.value }))}
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
                type="text"
                value={label}
                placeholder={state?.selfName ?? ''}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>

            <label className="field">
              <span>{t('settings.accountLang')}</span>
              <select value={defaultLang} onChange={(event) => setDefaultLang(event.target.value)}>
                <option value="">{t('settings.followGlobal')}</option>
                {LANGUAGES.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.label}
                  </option>
                ))}
              </select>
            </label>

            {isWhatsApp && (
              <>
                <label className="field">
                  <span>{t('account.device')}</span>
                  <input
                    type="text"
                    value={deviceLabel}
                    placeholder={t('account.deviceAuto')}
                    onChange={(event) => setDeviceLabel(event.target.value)}
                  />
                </label>
                <p className="field-hint">{t('account.deviceHint')}</p>
              </>
            )}
          </div>

          {actionError && <div className="account-modal-error" role="alert"><CircleAlert size={17} />{actionError}</div>}

          <div className="account-danger-zone">
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
        </div>

        <footer className="account-modal-footer">
          <button type="button" className="ghost-btn" onClick={onClose}>
            {t('settings.cancel')}
          </button>
          {isOAuth && !loggedIn ? (
            <button type="button" className="primary-btn" disabled={saving} onClick={() => void authorize()}>
              {t('account.oauthConnect')}
            </button>
          ) : needsCredentialConnect ? (
            <button
              type="button"
              className="primary-btn"
              disabled={saving || kakaoAuthenticating}
              onClick={() => void saveDetailsAndConnect()}
            >
              {t('account.saveConnect')}
            </button>
          ) : (
            <button type="button" className="primary-btn" disabled={saving} onClick={() => void saveDetails()}>
              {t('settings.save')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
