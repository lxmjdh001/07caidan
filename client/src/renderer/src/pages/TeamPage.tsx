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
  const [allPerms, setAllPerms] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // 建号表单：只填 @ 前的用户名，后缀 @<老板id> 系统拼接
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('agent')
  const [myId, setMyId] = useState<number | null>(null)

  // 建角色表单
  const [roleName, setRoleName] = useState('')
  const [rolePerms, setRolePerms] = useState<string[]>([])

  const reload = useCallback(async () => {
    try {
      const [m, r] = await Promise.all([
        api.billing<{ members: Member[] }>('listTeamMembers'),
        api.billing<{ roles: Role[]; permissions: string[] }>('listTeamRoles')
      ])
      setMembers(m.members)
      setRoles(r.roles)
      setAllPerms(r.permissions)
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

  const createMember = (): void => {
    if (!username || !password) {
      setErr(t('auth.fillAll'))
      return
    }
    void run(async () => {
      await api.billing('createTeamMember', { username, password, role })
      setUsername('')
      setPassword('')
    })
  }

  const permLabel = (p: string): string =>
    t(`team.perm.${p.replace(':', '_')}` as 'team.perm.campaigns_manage')

  const roleLabel = (m: Member): string =>
    m.role === 'agent' ? t('team.roleAgent') : m.role === 'boss' ? t('team.roleBoss') : m.roleName

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
            <h2>{t('team.members')}</h2>
            <p className="form-hint">{t('team.membersHint')}</p>
            {members.length === 0 && <p className="form-hint">{t('team.noMembers')}</p>}
            {members.map((m) => (
              <div key={m.id} className="team-member-row">
                <div className="team-member-main">
                  <span className="team-member-email">
                    {m.email}
                    {!m.enabled && <span className="team-disabled-tag">{t('team.disabled')}</span>}
                  </span>
                  <span className="team-member-perms">
                    {roleLabel(m)}
                    {m.permissions.length > 0 && ` · ${m.permissions.map(permLabel).join(' / ')}`}
                  </span>
                </div>
                <select
                  value={m.role}
                  disabled={busy}
                  onChange={(e) =>
                    void run(() => api.billing('updateTeamMember', m.id, { role: e.target.value }))
                  }
                >
                  <option value="agent">{t('team.roleAgent')}</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
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
                    if (pw) void run(() => api.billing('updateTeamMember', m.id, { password: pw }))
                  }}
                >
                  {t('team.resetPassword')}
                </button>
              </div>
            ))}
          </section>

          {/* 新建子账号 */}
          <section className="form-card">
            <h2>{t('team.addMember')}</h2>
            <p className="form-hint">{t('team.addMemberHint')}</p>
            <label className="field">
              <span>{t('team.username')}</span>
              <div className="code-row">
                <input
                  value={username}
                  placeholder="agent01"
                  onChange={(e) =>
                    // 只允许字母数字：从输入端就挡住 @ 和其他符号
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
            <button className="primary-btn" disabled={busy} onClick={createMember}>
              {t('team.create')}
            </button>
          </section>

          {/* 自定义角色 */}
          <section className="form-card">
            <h2>{t('team.roles')}</h2>
            <p className="form-hint">{t('team.rolesHint')}</p>
            {roles.map((r) => (
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
                  className="ghost-btn danger"
                  disabled={busy}
                  onClick={() => void run(() => api.billing('deleteTeamRole', r.id))}
                >
                  {t('team.deleteRole')}
                </button>
              </div>
            ))}
            <label className="field">
              <span>{t('team.roleName')}</span>
              <input value={roleName} onChange={(e) => setRoleName(e.target.value)} />
            </label>
            <div className="team-perm-grid">
              {allPerms.map((p) => (
                <label key={p} className="check-row">
                  <input
                    type="checkbox"
                    checked={rolePerms.includes(p)}
                    onChange={(e) =>
                      setRolePerms((prev) =>
                        e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)
                      )
                    }
                  />
                  <span>{permLabel(p)}</span>
                </label>
              ))}
            </div>
            <button
              className="primary-btn"
              disabled={busy || !roleName.trim()}
              onClick={() =>
                void run(async () => {
                  await api.billing('createTeamRole', {
                    name: roleName.trim(),
                    permissions: rolePerms
                  })
                  setRoleName('')
                  setRolePerms([])
                })
              }
            >
              {t('team.createRole')}
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
