import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient, Plan, RegisteredUserAdmin } from '../api'

interface Props { client: ApiClient }

function money(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`
}

function dateTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(value)
}

export function RegisteredUsersView({ client }: Props): React.JSX.Element {
  const [users, setUsers] = useState<RegisteredUserAdmin[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<RegisteredUserAdmin | null>(null)
  const [gifting, setGifting] = useState<RegisteredUserAdmin | null>(null)

  const reload = useCallback(async () => {
    try {
      const [u, p] = await Promise.all([client.listClientUsers(), client.listPlans()])
      setUsers(u.users)
      setPlans(p.plans)
      setError('')
    } catch (e) { setError((e as Error).message) }
  }, [client])
  useEffect(() => { void reload() }, [reload])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? users.filter((u) => u.email.toLowerCase().includes(q) || (u.ownerEmail || '').toLowerCase().includes(q)) : users
  }, [users, query])

  const toggle = async (u: RegisteredUserAdmin): Promise<void> => {
    try { await client.updateClientUser(u.id, { enabled: !u.enabled }); await reload() } catch (e) { setError((e as Error).message) }
  }

  const remove = async (u: RegisteredUserAdmin): Promise<void> => {
    if (!confirm(`确定删除注册用户 ${u.email}？此操作不可撤销。`)) return
    try { await client.deleteClientUser(u.id); await reload() } catch (e) { setError((e as Error).message) }
  }

  return <div className="users registered-users">
    <div className="users-head"><div><h2>注册用户管理</h2><div className="users-hint">管理桌面客户端注册账号、登录状态、余额与套餐。</div></div><button className="btn btn-sm" onClick={() => setCreating(true)}>+ 新增用户</button></div>
    <div className="table-toolbar"><input placeholder="搜索邮箱或所属账号" value={query} onChange={(e) => setQuery(e.target.value)} /><button className="btn btn-ghost btn-sm" onClick={() => void reload()}>刷新</button></div>
    {error && <div className="err">{error}</div>}
    <div className="table-scroll"><table className="users-table"><thead><tr><th>邮箱</th><th>等级</th><th>套餐</th><th>余额</th><th>剩余字符</th><th>端口额度</th><th>到期时间</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead><tbody>
      {filtered.map((u) => <tr key={u.id} className={u.enabled ? '' : 'off'}><td><strong>{u.email}</strong>{u.ownerEmail && <small className="table-sub">子账号 · {u.ownerEmail}</small>}</td><td>{u.ownerId ? '客服' : u.membershipTier === 'free' ? '免费用户' : u.membershipTier.toUpperCase()}</td><td>{u.subscription?.planName || '免费版'}</td><td>{money(u.balanceCents)}</td><td>{u.characters.toLocaleString()}</td><td>{u.accountQuota === 0 ? '无限制' : `${u.accountQuota}（赠送 ${u.bonusPorts}）`}</td><td>{u.subscription ? dateTime(u.subscription.expiresAt) : '永久'}</td><td><button className={`pill ${u.enabled ? 'on' : 'offp'}`} onClick={() => void toggle(u)}>{u.enabled ? '正常' : '已停用'}</button></td><td>{dateTime(u.createdAt)}</td><td className="row-actions"><button className="link-button" onClick={() => setGifting(u)}>赠送额度</button><button className="link-button" onClick={() => setEditing(u)}>编辑</button><button className="link-danger" onClick={() => void remove(u)}>删除</button></td></tr>)}
      {filtered.length === 0 && <tr><td colSpan={10} className="empty-cell">暂无注册用户</td></tr>}
    </tbody></table></div>
    {creating && <UserModal plans={plans} onClose={() => setCreating(false)} onSave={async (data) => { await client.createClientUser({ email: data.email, password: data.password, verified: data.verified }); setCreating(false); await reload() }} />}
    {editing && <UserModal user={editing} plans={plans} onClose={() => setEditing(null)} onSave={async (data) => { await client.updateClientUser(editing.id, { email: data.email, password: data.password || undefined, verified: data.verified }); if (data.planId) await client.setClientUserSubscription(editing.id, { planId: data.planId, expiresAt: data.expiresAt ? new Date(data.expiresAt).getTime() : undefined, autoRenew: data.autoRenew }); setEditing(null); await reload() }} />}
    {gifting && <GiftModal user={gifting} onClose={() => setGifting(null)} onSave={async (characters, ports, note) => { await client.giftEntitlements({ userId: gifting.ownerId ?? gifting.id, characters, ports, note }); setGifting(null); await reload() }} />}
  </div>
}

function GiftModal({ user, onClose, onSave }: { user: RegisteredUserAdmin; onClose: () => void; onSave: (characters: number, ports: number, note: string) => Promise<void> }): React.JSX.Element {
  const [characters, setCharacters] = useState('')
  const [ports, setPorts] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const charValue = Math.max(0, Math.floor(Number(characters) || 0))
  const portValue = Math.max(0, Math.floor(Number(ports) || 0))
  return <div className="modal-backdrop" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}><h3>赠送字符 / 端口</h3><p className="users-hint">{user.email}{user.ownerEmail ? `（额度归入主账号 ${user.ownerEmail}）` : ''}</p><label className="field"><span>赠送翻译字符</span><input type="number" min="0" step="1" placeholder="例如 100000" value={characters} onChange={(e) => setCharacters(e.target.value)} /></label><label className="field"><span>赠送额外端口</span><input type="number" min="0" step="1" placeholder="例如 20" value={ports} onChange={(e) => setPorts(e.target.value)} /></label><label className="field"><span>备注</span><input placeholder="例如：活动赠送" value={note} onChange={(e) => setNote(e.target.value)} /></label><div className="modal-actions"><button className="btn btn-ghost btn-sm" onClick={onClose}>取消</button><button className="btn btn-sm" disabled={busy || (charValue === 0 && portValue === 0)} onClick={async () => { setBusy(true); try { await onSave(charValue, portValue, note) } finally { setBusy(false) } }}>{busy ? '赠送中…' : '确认赠送'}</button></div></div></div>
}

function UserModal({ user, plans, onClose, onSave }: { user?: RegisteredUserAdmin; plans: Plan[]; onClose: () => void; onSave: (data: { email: string; password: string; verified: boolean; planId: string; expiresAt: string; autoRenew: boolean }) => Promise<void> }): React.JSX.Element {
  const [email, setEmail] = useState(user?.email || '')
  const [password, setPassword] = useState('')
  const [verified, setVerified] = useState(user?.verified ?? true)
  const [planId, setPlanId] = useState(user?.subscription?.planId || '')
  const [expiresAt, setExpiresAt] = useState(user?.subscription ? new Date(user.subscription.expiresAt).toISOString().slice(0, 16) : '')
  const [autoRenew, setAutoRenew] = useState(user?.subscription?.autoRenew ?? false)
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => { setBusy(true); try { await onSave({ email, password, verified, planId, expiresAt, autoRenew }) } finally { setBusy(false) } }
  return <div className="modal-backdrop" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}><h3>{user ? '编辑注册用户' : '新增注册用户'}</h3><label className="field"><span>登录邮箱</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label><label className="field"><span>{user ? '重置密码（留空不修改）' : '初始密码'}</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label><label className="check"><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} /> 已验证邮箱</label>{user && <><label className="field"><span>套餐</span><select value={planId} onChange={(e) => setPlanId(e.target.value)}><option value="">不调整套餐</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.priceCents)}</option>)}</select></label>{planId && <label className="field"><span>到期时间</span><input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></label>} {planId && <label className="check"><input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} /> 自动续费</label>}</>}<div className="modal-actions"><button className="btn btn-ghost btn-sm" onClick={onClose}>取消</button><button className="btn btn-sm" disabled={busy || !email || (!user && !password)} onClick={() => void submit()}>{busy ? '保存中…' : '保存'}</button></div></div></div>
}
