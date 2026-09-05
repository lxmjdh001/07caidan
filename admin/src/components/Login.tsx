import { useEffect, useState } from 'react'
import { ApiClient, login, type Me } from '../api'
import { API_BASE } from '../config'
import { brand } from '../branding'
import { BrandMark } from './BrandMark'
import { useI18n } from '../i18n'

interface Props {
  onLogin: (client: ApiClient, base: string, me: Me) => void
}

export function Login({ onLogin }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    try {
      const { token, user } = await login(API_BASE, username.trim(), password)
      localStorage.setItem('omni_token', token)
      onLogin(new ApiClient(API_BASE, token), API_BASE, user)
    } catch (e) {
      setErr(`${t('login.failed')}：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // 记住上次会话令牌，自动恢复
  useEffect(() => {
    // 变量名避开 i18n 的 t，否则在同一文件里读起来很容易混
    const saved = localStorage.getItem('omni_token')
    if (saved) {
      const client = new ApiClient(API_BASE, saved)
      client
        .me()
        .then((me) => onLogin(client, API_BASE, me))
        .catch(() => localStorage.removeItem('omni_token'))
    }
  }, [onLogin])

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-brand-mark"><BrandMark /></div>
        <h1>{brand.appName}</h1>
        <p>{t('login.sub')}</p>
        <label className="field">
          <span>{t('login.username')}</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
        </label>
        <label className="field">
          <span>{t('login.password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder={t('login.password')}
          />
        </label>
        <button className="btn" disabled={busy} onClick={() => void submit()}>
          {busy ? `${t('login.submit')}…` : t('login.submit')}
        </button>
        <div className="err">{err}</div>
      </div>
    </div>
  )
}
