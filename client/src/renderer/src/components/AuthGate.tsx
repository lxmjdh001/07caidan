import { useEffect, useState } from 'react'
import type { AuthState } from '@shared/ipc'
import { useI18n } from '../i18n'

const api = window.omni

interface Props {
  onAuthed: () => void
}

/** 登录/注册门禁：未登录时挡在主应用之前 */
export function AuthGate({ onAuthed }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [serverUrl, setServerUrl] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [requireVerify, setRequireVerify] = useState(false)
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [codeSent, setCodeSent] = useState(false)

  useEffect(() => {
    void api.authState().then((s: AuthState) => setServerUrl(s.serverUrl))
  }, [])

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
    if (!serverUrl || !email || !password) {
      setErr(t('auth.fillAll'))
      return
    }
    setBusy(true)
    const r =
      mode === 'login'
        ? await api.authLogin(serverUrl, email, password)
        : await api.authRegister(serverUrl, email, password, requireVerify ? code : undefined)
    setBusy(false)
    if (r.ok) onAuthed()
    else setErr(r.error ?? t('auth.failed'))
  }

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <div className="auth-logo">OC</div>
        <h1>{t('app.name')}</h1>
        <p className="auth-sub">{mode === 'login' ? t('auth.loginSub') : t('auth.registerSub')}</p>

        <label className="field">
          <span>{t('auth.serverUrl')}</span>
          <input
            type="text"
            value={serverUrl}
            placeholder="https://api.example.com"
            onChange={(e) => setServerUrl(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('auth.email')}</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('auth.password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !(mode === 'register' && requireVerify)) void submit()
            }}
          />
        </label>

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

        {err && <div className="auth-err">{err}</div>}
        {info && <div className="auth-info">{info}</div>}

        <button className="primary-btn auth-submit" disabled={busy} onClick={() => void submit()}>
          {busy ? '…' : mode === 'login' ? t('auth.login') : t('auth.register')}
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
