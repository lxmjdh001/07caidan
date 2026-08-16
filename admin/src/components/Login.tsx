import { useEffect, useState } from 'react'
import { ApiClient, login, type Me } from '../api'
import { API_BASE } from '../config'

interface Props {
  onLogin: (client: ApiClient, base: string, me: Me) => void
}

export function Login({ onLogin }: Props): React.JSX.Element {
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
      setErr('登录失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 记住上次会话令牌，自动恢复
  useEffect(() => {
    const t = localStorage.getItem('omni_token')
    if (t) {
      const client = new ApiClient(API_BASE, t)
      client
        .me()
        .then((me) => onLogin(client, API_BASE, me))
        .catch(() => localStorage.removeItem('omni_token'))
    }
  }, [onLogin])

  return (
    <div className="login">
      <div className="login-card">
        <h1>OmniChat 管理后台</h1>
        <p>使用账号密码登录</p>
        <label className="field">
          <span>账号</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder="密码"
          />
        </label>
        <button className="btn" disabled={busy} onClick={() => void submit()}>
          {busy ? '登录中…' : '登录'}
        </button>
        <div className="err">{err}</div>
      </div>
    </div>
  )
}
