import { useEffect, useState } from 'react'
import { ApiClient, login, type Me } from '../api'

interface Props {
  onLogin: (client: ApiClient, base: string, me: Me) => void
}

export function Login({ onLogin }: Props): React.JSX.Element {
  const [url, setUrl] = useState('http://localhost:8787')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    try {
      const base = url.trim().replace(/\/$/, '')
      const { token, user } = await login(base, username.trim(), password)
      localStorage.setItem('omni_base', base)
      localStorage.setItem('omni_token', token)
      onLogin(new ApiClient(base, token), base, user)
    } catch (e) {
      setErr('登录失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 记住上次会话令牌，自动恢复
  useEffect(() => {
    const t = localStorage.getItem('omni_token')
    const b = localStorage.getItem('omni_base')
    if (t && b) {
      setUrl(b)
      const client = new ApiClient(b, t)
      client
        .me()
        .then((me) => onLogin(client, b, me))
        .catch(() => localStorage.removeItem('omni_token'))
    }
  }, [onLogin])

  return (
    <div className="login">
      <div className="login-card">
        <h1>OmniChat 管理后台</h1>
        <p>使用账号密码登录</p>
        <label className="field">
          <span>后台地址</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8787" />
        </label>
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
