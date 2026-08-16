import { useEffect, useState } from 'react'
import type { AdminUser, ApiClient, PermMeta } from '../api'
import { useI18n } from '../i18n'


interface Props {
  client: ApiClient
  currentUser: string
}

export function UsersView({ client, currentUser }: Props): React.JSX.Element {
  const { t } = useI18n()
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
    if (!confirm(t('users.deleteUserConfirm', { name: u.username }))) return
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
        <h2>{t('users.titleRbac')}</h2>
        <button className="btn btn-sm" onClick={() => setCreating(true)}>
          + {t('users.add')}
        </button>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="users-hint">
        {t('users.rbacHint')}
      </div>
      <table className="users-table">
        <thead>
          <tr>
            <th>{t('users.username')}</th>
            <th>{t('users.role')}</th>
            {meta?.permissions.map((p) => (
              <th key={p}>{permLabel(t)[p] ?? p}</th>
            ))}
            <th>{t('users.status')}</th>
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
                  {u.username === currentUser && <span className="me-badge">{t('users.me')}</span>}
                </td>
                <td>
                  <select value={u.role} onChange={(e) => void changeRole(u, e.target.value)}>
                    {meta?.roles.map((r) => (
                      <option key={r} value={r}>
                        {roleLabel(t)[r] ?? r}
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
                        title={fromRole ? t('users.fromRole') : t('users.direct')}
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
                    {u.enabled ? t('users.enabled') : t('users.disable')}
                  </button>
                </td>
                <td>
                  {u.username !== currentUser && (
                    <button className="link-danger" onClick={() => void remove(u)}>
                      {t('common.delete')}
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
  const { t } = useI18n()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState(meta.roles[meta.roles.length - 1] ?? 'viewer')
  const [extra, setExtra] = useState<string[]>([])

  const preset = new Set(meta.rolePresets[role] ?? [])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('users.add')}</h3>
        <label className="field">
          <span>{t('users.username')}</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('users.password')}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('users.role')}</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {meta.roles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(t)[r] ?? r}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span>{t('users.extraOnly')}</span>
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
                  {permLabel(t)[p] ?? p}
                  {fromRole && <span className="from-role">{t('users.preset')}</span>}
                </label>
              )
            })}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-sm"
            disabled={!username || !password}
            onClick={() => void onCreate({ username, password, role, permissions: extra })}
          >
            {t('users.create2')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 角色/权限的展示名走字典，后端返回的是稳定 key */
function roleLabel(t: ReturnType<typeof useI18n>['t']): Record<string, string> {
  return {
    owner: t('role.owner'),
    admin: t('role.admin'),
    agent: t('role.agent'),
    viewer: t('role.viewer')
  }
}

function permLabel(t: ReturnType<typeof useI18n>['t']): Record<string, string> {
  return {
    'conversations:read': t('perm.conversations:read'),
    'analyze:run': t('perm.analyze:run'),
    'campaigns:manage': t('perm.campaigns:manage'),
    'users:manage': t('perm.users:manage')
  }
}
