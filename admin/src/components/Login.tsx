import { useEffect, useState } from 'react'
import { ApiClient, type Conversation } from '../api'

interface Props {
  onLogin: (client: ApiClient, base: string, conversations: Conversation[]) => void
}

export function Login({ onLogin }: Props): React.JSX.Element {
  const [url, setUrl] = useState('http://localhost:8787')
  const [token, setToken] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    try {
      const base = url.trim().replace(/\/$/, '')
      const client = new ApiClient(base, token.trim())
      const { conversations } = await client.listConversations()
      localStorage.setItem('omni_base', base)
      localStorage.setItem('omni_token', token.trim())
      onLogin(client, base, conversations)
    } catch (e) {
      setErr('登录失败：' + (e as Error).message + '（检查地址与令牌）')
    } finally {
      setBusy(false)
    }
  }

  // 记住上次登录，自动尝试
  useEffect(() => {
    const t = localStorage.getItem('omni_token')
    const b = localStorage.getItem('omni_base')
    if (t && b) {
      setUrl(b)
      setToken(t)
      const client = new ApiClient(b, t)
      client
        .listConversations()
        .then(({ conversations }) => onLogin(client, b, conversations))
        .catch(() => {
          /* 令牌失效则停在登录页 */
        })
    }
  }, [onLogin])

  return (
    <div className="login">
      <div className="login-card">
        <h1>OmniChat 管理后台</h1>
        <p>输入后台地址与同步令牌登录</p>
        <label className="field">
          <span>后台地址</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8787" />
        </label>
        <label className="field">
          <span>令牌 Token</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder="同步令牌"
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
