import { useEffect, useState } from 'react'
import type { AdminUser, ApiClient, PermMeta } from '../api'

const ROLE_LABEL: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  agent: '客服',
  viewer: '只读'
}
const PERM_LABEL: Record<string, string> = {
  'conversations:read': '查看聊天记录',
  'analyze:run': '运行 AI 分析',
  'users:manage': '管理用户'
}

interface Props {
  client: ApiClient
  currentUser: string
}

export function UsersView({ client, currentUser }: Props): React.JSX.Element {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [meta, setMeta] = useState<PermMeta | null>(null)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)

  const reload = (): void => {
    client
      .listUsers()
      .then((r) => setUsers(r.users))
      .catch((e) => setErr((e as Error).message))
  }

  useEffect(() => {
    client.permMeta().then(setMeta).catch(() => {})
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  const toggleEnabled = async (u: AdminUser): Promise<void> => {
    await client.updateUser(u.id, { enabled: !u.enabled })
    reload()
  }
  const changeRole = async (u: AdminUser, role: string): Promise<void> => {
    await client.updateUser(u.id, { role })
    reload()
  }
  const togglePerm = async (u: AdminUser, perm: string): Promise<void> => {
    const set = new Set(u.permissions)
    if (set.has(perm)) set.delete(perm)
    else set.add(perm)
    await client.updateUser(u.id, { permissions: [...set] })
    reload()
  }
  const remove = async (u: AdminUser): Promise<void> => {
    if (!confirm(`删除用户 ${u.username}？`)) return
    try {
      await client.deleteUser(u.id)
      reload()
    } catch (e) {
      alert((e as Error).message)
    }
  }

  return (
    <div className="users">
      <div className="users-head">
        <h2>用户管理（RBAC）</h2>
        <button className="btn btn-sm" onClick={() => setCreating(true)}>
          + 新增用户
        </button>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="users-hint">
        角色是权限预设；下方勾选可在预设之外<strong>直接分配</strong>具体权限（勾选=拥有该权限）。
      </div>
      <table className="users-table">
        <thead>
          <tr>
            <th>账号</th>
            <th>角色</th>
            {meta?.permissions.map((p) => (
              <th key={p}>{PERM_LABEL[p] ?? p}</th>
            ))}
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const preset = new Set(meta?.rolePresets[u.role] ?? [])
            return (
              <tr key={u.id} className={u.enabled ? '' : 'off'}>
                <td>
                  {u.username}
                  {u.username === currentUser && <span className="me-badge">当前</span>}
                </td>
                <td>
                  <select value={u.role} onChange={(e) => void changeRole(u, e.target.value)}>
                    {meta?.roles.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r] ?? r}
                      </option>
                    ))}
                  </select>
                </td>
                {meta?.permissions.map((p) => {
                  const fromRole = preset.has(p)
                  const has = fromRole || u.permissions.includes(p)
                  return (
                    <td key={p} className="perm-cell">
                      <input
                        type="checkbox"
                        checked={has}
                        disabled={fromRole}
                        title={fromRole ? '来自角色预设' : '直接分配'}
                        onChange={() => void togglePerm(u, p)}
                      />
                    </td>
                  )
                })}
                <td>
                  <button
                    className={`pill ${u.enabled ? 'on' : 'offp'}`}
                    onClick={() => void toggleEnabled(u)}
                  >
                    {u.enabled ? '启用' : '停用'}
                  </button>
                </td>
                <td>
                  {u.username !== currentUser && (
                    <button className="link-danger" onClick={() => void remove(u)}>
                      删除
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {creating && meta && (
        <CreateUser
          meta={meta}
          onClose={() => setCreating(false)}
          onCreate={async (b) => {
            try {
              await client.createUser(b)
              setCreating(false)
              reload()
            } catch (e) {
              alert((e as Error).message)
            }
          }}
        />
      )}
    </div>
  )
}

function CreateUser({
  meta,
  onClose,
  onCreate
}: {
  meta: PermMeta
  onClose: () => void
  onCreate: (b: {
    username: string
    password: string
    role: string
    permissions: string[]
  }) => Promise<void>
}): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState(meta.roles[meta.roles.length - 1] ?? 'viewer')
  const [extra, setExtra] = useState<string[]>([])

  const preset = new Set(meta.rolePresets[role] ?? [])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>新增用户</h3>
        <label className="field">
          <span>账号</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span>密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="field">
          <span>角色</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {meta.roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r] ?? r}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>额外权限（角色预设之外）</span>
          <div className="perm-checks">
            {meta.permissions.map((p) => {
              const fromRole = preset.has(p)
              return (
                <label key={p} className={`perm-check ${fromRole ? 'disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={fromRole || extra.includes(p)}
                    disabled={fromRole}
                    onChange={(e) =>
                      setExtra((prev) =>
                        e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)
                      )
                    }
                  />
                  {PERM_LABEL[p] ?? p}
                  {fromRole && <span className="from-role">预设</span>}
                </label>
              )
            })}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-sm"
            disabled={!username || !password}
            onClick={() => void onCreate({ username, password, role, permissions: extra })}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
