import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { brand } from '@shared/branding'
import { BrandMark } from './BrandMark'

const api = window.omni

interface Props {
  onAuthed: () => void
}

/** 登录/注册门禁：未登录时挡在主应用之前 */
export function AuthGate({ onAuthed }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login')
  // 后台地址打包进品牌配置，用户只填邮箱和密码
  const serverUrl = brand.apiUrl
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [requireVerify, setRequireVerify] = useState(false)
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [codeSent, setCodeSent] = useState(false)

  // 切到注册模式或改地址时，探测后台是否需要邮箱验证
  useEffect(() => {
    if (mode !== 'register' || !serverUrl) return
    void api.authConfig(serverUrl).then((c) => {
      if ('requireEmailVerify' in c) setRequireVerify(c.requireEmailVerify)
    })
  }, [mode, serverUrl])

  const sendCode = async (): Promise<void> => {
    setErr('')
    if (!email) {
      setErr(t('auth.needEmail'))
      return
    }
    setBusy(true)
    const r = await api.authSendCode(serverUrl, email)
    setBusy(false)
    if (r.ok) {
      setCodeSent(true)
      setInfo(t('auth.codeSent'))
    } else {
      setErr(r.error ?? t('auth.failed'))
    }
  }

  const submit = async (): Promise<void> => {
    setErr('')
    setInfo('')
    if (mode === 'forgot') {
      if (!serverUrl || !email || !code || !password) {
        setErr(t('auth.fillAll'))
        return
      }
      setBusy(true)
      const r = await api.authResetPassword(serverUrl, email, code, password)
      setBusy(false)
      if (r.ok) {
        // 改密成功回到登录：旧会话已全部失效，必须重新登录
        setMode('login')
        setPassword('')
        setCode('')
        setCodeSent(false)
        setInfo(t('auth.resetDone'))
      } else setErr(r.error ?? t('auth.failed'))
      return
    }
    if (!serverUrl || !email || !password) {
      setErr(t('auth.fillAll'))
      return
    }
    setBusy(true)
    const r =
      mode === 'login'
        ? await api.authLogin(serverUrl, email, password)
        : await api.authRegister(serverUrl, email, password, requireVerify ? code : undefined, inviteCode)
    setBusy(false)
    if (r.ok) onAuthed()
    else setErr(r.error ?? t('auth.failed'))
  }

  /** 找回密码：发送验证码（后端无论邮箱是否注册都回 ok，防探测） */
  const sendResetCode = async (): Promise<void> => {
    setErr('')
    if (!serverUrl || !email) {
      setErr(t('auth.needEmail'))
      return
    }
    setBusy(true)
    const r = await api.authForgotPassword(serverUrl, email)
    setBusy(false)
    if (r.ok) {
      setCodeSent(true)
      setInfo(t('auth.codeSent'))
    } else setErr(r.error ?? t('auth.failed'))
  }

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <div className="auth-logo"><BrandMark /></div>
        <h1>{brand.appName}</h1>
        <p className="auth-sub">
          {mode === 'login'
            ? t('auth.loginSub')
            : mode === 'register'
              ? t('auth.registerSub')
              : t('auth.forgotSub')}
        </p>

        <label className="field">
          <span>{t('auth.email')}</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>{mode === 'forgot' ? t('auth.newPassword') : t('auth.password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !(mode === 'register' && requireVerify)) void submit()
            }}
          />
        </label>

        {mode === 'forgot' && (
          <label className="field">
            <span>{t('auth.code')}</span>
            <div className="code-row">
              <input value={code} onChange={(e) => setCode(e.target.value)} />
              <button
                type="button"
                className="ghost-btn"
                disabled={busy || codeSent}
                onClick={() => void sendResetCode()}
              >
                {codeSent ? t('auth.codeResent') : t('auth.sendCode')}
              </button>
            </div>
          </label>
        )}

        {mode === 'register' && requireVerify && (
          <label className="field">
            <span>{t('auth.code')}</span>
            <div className="code-row">
              <input value={code} onChange={(e) => setCode(e.target.value)} />
              <button
                type="button"
                className="ghost-btn"
                disabled={busy || codeSent}
                onClick={() => void sendCode()}
              >
                {codeSent ? t('auth.codeResent') : t('auth.sendCode')}
              </button>
            </div>
          </label>
        )}

        {mode === 'register' && (
          <label className="field">
            <span>{t('auth.inviteCode')}</span>
            <input
              value={inviteCode}
              maxLength={24}
              autoComplete="off"
              placeholder={t('auth.inviteCodeHint')}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
            />
          </label>
        )}

        {err && <div className="auth-err">{err}</div>}
        {info && <div className="auth-info">{info}</div>}

        <button className="primary-btn auth-submit" disabled={busy} onClick={() => void submit()}>
          {busy
            ? '…'
            : mode === 'login'
              ? t('auth.login')
              : mode === 'register'
                ? t('auth.register')
                : t('auth.doReset')}
        </button>

        <div className="auth-switch">
          {mode === 'login' ? (
            <>
              {t('auth.noAccount')}{' '}
              <button
                type="button"
                onClick={() => {
                  setMode('register')
                  setErr('')
                  setInfo('')
                }}
              >
                {t('auth.toRegister')}
              </button>
              {' · '}
              <button
                type="button"
                onClick={() => {
                  setMode('forgot')
                  setErr('')
                  setInfo('')
                  setCodeSent(false)
                }}
              >
                {t('auth.forgot')}
              </button>
            </>
          ) : (
            <>
              {t('auth.hasAccount')}{' '}
              <button
                type="button"
                onClick={() => {
                  setMode('login')
                  setErr('')
                  setInfo('')
                }}
              >
                {t('auth.toLogin')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
