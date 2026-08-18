import { useCallback, useEffect, useState } from 'react'
import { errText } from '../errors'
import { useI18n } from '../i18n'

const api = window.omni

interface Member {
  id: number
  email: string
  role: string
  roleName: string
  permissions: string[]
  enabled: boolean
  createdAt: number
}

interface Role {
  id: string
  name: string
  permissions: string[]
}

interface Device {
  deviceId: string
  deviceName: string
  lastSeenAt: number
  firstSeenAt: number
  sessions: number
  current: boolean
}

/**
 * 团队管理（老板视角）：客服子账号 + 自定义角色。
 *
 * 子账号消耗老板的套餐与余额；角色只能由老板自己权限的子集组成
 * （服务端做 ⊆ 校验，这里只是操作界面）。
 */
export function TeamPage(): React.JSX.Element {
  const { t } = useI18n()
  const [members, setMembers] = useState<Member[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [allPerms, setAllPerms] = useState<string[]>([])
  const [myId, setMyId] = useState<number | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAddMember, setShowAddMember] = useState(false)
  const [showAddRole, setShowAddRole] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [m, r, d] = await Promise.all([
        api.billing<{ members: Member[] }>('listTeamMembers'),
        api.billing<{ roles: Role[]; permissions: string[] }>('listTeamRoles'),
        api.billing<{ devices: Device[] }>('listDevices')
      ])
      setMembers(m.members)
      setRoles(r.roles)
      setAllPerms(r.permissions)
      setDevices(d.devices)
      setErr('')
    } catch (e) {
      setErr(errText(e))
    }
  }, [])

  useEffect(() => {
    void reload()
    void api
      .billing<{ userId: number }>('myIdentity')
      .then((r) => setMyId(r.userId))
      .catch(() => setMyId(null))
  }, [reload])

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      await fn()
      await reload()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const permLabel = (p: string): string =>
    t(`team.perm.${p.replace(':', '_')}` as 'team.perm.campaigns_manage')

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('team.title')}</h1>
      </header>
      <div className="page-body">
        <div className="form-page">
          {err && <div className="auth-err">{err}</div>}

          {/* 成员列表 */}
          <section className="form-card">
            <div className="card-head-row">
              <h2>{t('team.members')}</h2>
              <button
                type="button"
                className="primary-btn"
                onClick={() => setShowAddMember(true)}
              >
                {t('team.addMember')}
              </button>
            </div>
            <p className="form-hint">{t('team.membersHint')}</p>
            {members.length === 0 ? (
              <p className="form-hint">{t('team.noMembers')}</p>
            ) : (
              <table className="data-table team-table">
                <thead>
                  <tr>
                    <th>{t('team.loginName')}</th>
                    <th>{t('team.role')}</th>
                    <th>{t('team.permCol')}</th>
                    <th aria-label="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id} className={m.enabled ? '' : 'row-off'}>
                      <td className="team-login-cell">
                        {m.email}
                        {!m.enabled && (
                          <span className="team-disabled-tag">{t('team.disabled')}</span>
                        )}
                      </td>
                      <td>
                        <select
                          className="team-role-select"
                          value={m.role}
                          disabled={busy}
                          onChange={(e) =>
                            void run(() =>
                              api.billing('updateTeamMember', m.id, { role: e.target.value })
                            )
                          }
                        >
                          <option value="agent">{t('team.roleAgent')}</option>
                          {roles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="team-perm-cell">
                        {m.permissions.length > 0
                          ? m.permissions.map(permLabel).join(' / ')
                          : t('team.chatOnly')}
                      </td>
                      <td className="team-actions">
                        <button
                          type="button"
                          className="ghost-btn"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              api.billing('updateTeamMember', m.id, { enabled: !m.enabled })
                            )
                          }
                        >
                          {m.enabled ? t('team.disable') : t('team.enable')}
                        </button>
                        <button
                          type="button"
                          className="ghost-btn"
                          disabled={busy}
                          onClick={() => {
                            const pw = window.prompt(t('team.newPasswordPrompt'))
                            if (pw) {
                              void run(() =>
                                api.billing('updateTeamMember', m.id, { password: pw })
                              )
                            }
                          }}
                        >
                          {t('team.resetPassword')}
                        </button>
                        <button
                          type="button"
                          className="danger-btn"
                          disabled={busy}
                          onClick={() => {
                            if (
                              !window.confirm(
                                t('team.deleteConfirm').replace('{name}', m.email)
                              )
                            )
                              return
                            void run(() => api.billing('deleteTeamMember', m.id))
                          }}
                        >
                          {t('team.deleteMember')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* 自定义角色 */}
          <section className="form-card">
            <div className="card-head-row">
              <h2>{t('team.roles')}</h2>
              <button type="button" className="primary-btn" onClick={() => setShowAddRole(true)}>
                {t('team.createRole')}
              </button>
            </div>
            <p className="form-hint">{t('team.rolesHint')}</p>
            {roles.length === 0 ? (
              <p className="form-hint">{t('team.noRoles')}</p>
            ) : (
              roles.map((r) => (
                <div key={r.id} className="team-member-row">
                  <div className="team-member-main">
                    <span className="team-member-email">{r.name}</span>
                    <span className="team-member-perms">
                      {r.permissions.length > 0
                        ? r.permissions.map(permLabel).join(' / ')
                        : t('team.chatOnly')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="danger-btn"
                    disabled={busy}
                    onClick={() => void run(() => api.billing('deleteTeamRole', r.id))}
                  >
                    {t('team.deleteRole')}
                  </button>
                </div>
              ))
            )}
          </section>

          {/* 登录设备（一订阅限 N 台 + 远程下线）*/}
          <section className="form-card">
            <div className="card-head-row">
              <h2>{t('team.devices')}</h2>
            </div>
            <p className="form-hint">{t('team.devicesHint')}</p>
            {devices.length === 0 ? (
              <p className="form-hint">{t('team.noDevices')}</p>
            ) : (
              <table className="data-table team-table">
                <thead>
                  <tr>
                    <th>{t('team.deviceName')}</th>
                    <th>{t('team.deviceLastSeen')}</th>
                    <th className="num">{t('team.deviceSessions')}</th>
                    <th aria-label="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.deviceId}>
                      <td className="team-login-cell">
                        {d.deviceName}
                        {d.current && <span className="team-disabled-tag">{t('team.deviceCurrent')}</span>}
                      </td>
                      <td>{new Date(d.lastSeenAt).toLocaleString()}</td>
                      <td className="num">{d.sessions}</td>
                      <td className="team-actions">
                        <button
                          type="button"
                          className="danger-btn"
                          disabled={busy || d.current}
                          title={d.current ? t('team.deviceCurrentHint') : ''}
                          onClick={() => {
                            if (!window.confirm(t('team.deviceRevokeConfirm').replace('{name}', d.deviceName)))
                              return
                            void run(() => api.billing('revokeDevice', d.deviceId))
                          }}
                        >
                          {t('team.deviceRevoke')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>

      {showAddMember && (
        <AddMemberModal
          roles={roles}
          myId={myId}
          onClose={() => setShowAddMember(false)}
          onCreated={async () => {
            setShowAddMember(false)
            await reload()
          }}
        />
      )}
      {showAddRole && (
        <AddRoleModal
          allPerms={allPerms}
          permLabel={permLabel}
          onClose={() => setShowAddRole(false)}
          onCreated={async () => {
            setShowAddRole(false)
            await reload()
          }}
        />
      )}
    </div>
  )
}

/** 新建子账号弹窗 */
function AddMemberModal({
  roles,
  myId,
  onClose,
  onCreated
}: {
  roles: Role[]
  myId: number | null
  onClose: () => void
  onCreated: () => Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('agent')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!username || !password) {
      setErr(t('auth.fillAll'))
      return
    }
    setErr('')
    setBusy(true)
    try {
      await api.billing('createTeamMember', { username, password, role })
      await onCreated()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={(e) => e.stopPropagation()}>
        <h2>{t('team.addMember')}</h2>
        <p className="form-hint">{t('team.addMemberHint')}</p>
        <label className="field">
          <span>{t('team.username')}</span>
          <div className="code-row">
            <input
              value={username}
              placeholder="agent01"
              autoFocus
              onChange={(e) =>
                setUsername(e.target.value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
              }
            />
            {myId !== null && <span className="team-suffix">@{myId}</span>}
          </div>
          <span className="field-hint">{t('team.usernameHint')}</span>
        </label>
        <label className="field">
          <span>{t('auth.password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </label>
        <label className="field">
          <span>{t('team.role')}</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="agent">{t('team.roleAgent')}</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        {err && <div className="auth-err">{err}</div>}
        <footer className="modal-footer">
          <button type="button" className="ghost-btn" onClick={onClose}>
            {t('settings.cancel')}
          </button>
          <button
            type="button"
            className="primary-btn"
            disabled={busy || !username || !password}
            onClick={() => void submit()}
          >
            {t('team.create')}
          </button>
        </footer>
      </div>
    </div>
  )
}

/** 新建自定义角色弹窗 */
function AddRoleModal({
  allPerms,
  permLabel,
  onClose,
  onCreated
}: {
  allPerms: string[]
  permLabel: (p: string) => string
  onClose: () => void
  onCreated: () => Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [perms, setPerms] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={(e) => e.stopPropagation()}>
        <h2>{t('team.createRole')}</h2>
        <p className="form-hint">{t('team.rolesHint')}</p>
        <label className="field">
          <span>{t('team.roleName')}</span>
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="team-perm-grid">
          {allPerms.map((p) => (
            <label key={p} className="check-row">
              <input
                type="checkbox"
                checked={perms.includes(p)}
                onChange={(e) =>
                  setPerms((prev) =>
                    e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)
                  )
                }
              />
              <span>{permLabel(p)}</span>
            </label>
          ))}
        </div>
        {err && <div className="auth-err">{err}</div>}
        <footer className="modal-footer">
          <button type="button" className="ghost-btn" onClick={onClose}>
            {t('settings.cancel')}
          </button>
          <button
            type="button"
            className="primary-btn"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setErr('')
              setBusy(true)
              try {
                await api.billing('createTeamRole', { name: name.trim(), permissions: perms })
                await onCreated()
              } catch (e) {
                setErr(errText(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('team.createRole')}
          </button>
        </footer>
      </div>
    </div>
  )
}
