import { randomBytes } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import { hashPassword, newSessionToken, verifyPassword } from './auth.ts'
import type { Db } from './db.ts'
import { randomUUID } from 'node:crypto'
import { clientRoles, clientSessions, clientUsers, emailCodes } from './schema.ts'
import {
  CLIENT_ROLE_PRESETS,
  canDelegate,
  effectiveClientPermissions,
  isClientPermission
} from './client-rbac.ts'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const CODE_TTL_MS = 10 * 60 * 1000

export interface ClientUser {
  id: number
  tenant: string
  email: string
  verified: boolean
  /** 归属老板；空 = 自己是老板 */
  ownerId?: number
  role: string
  /** 有效权限（角色 ∪ 直接分配） */
  permissions: string[]
}

export interface TeamMember {
  id: number
  email: string
  role: string
  roleName: string
  permissions: string[]
  enabled: boolean
  createdAt: number
}

export interface ClientRole {
  id: string
  name: string
  permissions: string[]
}

export type RegisterResult =
  | { ok: true; token: string; user: ClientUser }
  | { ok: false; error: string }

/** 客户端用户（桌面端账号）认证：注册/登录/邮箱验证码。 */
export class ClientAuthRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  /** 生成并存储验证码（6 位数字），返回验证码供发信 */
  issueCode(email: string): string {
    // 用时间戳派生但不可预测：随机 6 位
    const code = String(Math.floor(100000 + secureRand() * 900000))
    this.db
      .insert(emailCodes)
      .values({ email, code, expiresAt: Date.now() + CODE_TTL_MS })
      .onConflictDoUpdate({
        target: emailCodes.email,
        set: { code, expiresAt: Date.now() + CODE_TTL_MS }
      })
      .run()
    return code
  }

  private checkCode(email: string, code: string): boolean {
    const row = this.db.select().from(emailCodes).where(eq(emailCodes.email, email)).get()
    if (!row || row.expiresAt < Date.now()) return false
    if (row.code !== code) return false
    // 用后即焚
    this.db.delete(emailCodes).where(eq(emailCodes.email, email)).run()
    return true
  }

  /**
   * 注册。requireVerify 为 true 时必须提供正确验证码。
   * 成功后直接登录（返回会话令牌）。
   */
  register(
    tenant: string,
    email: string,
    password: string,
    code: string | undefined,
    requireVerify: boolean
  ): RegisterResult {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false, error: '邮箱格式不正确' }
    }
    if (password.length < 6) return { ok: false, error: '密码至少 6 位' }

    const exists = this.db.select().from(clientUsers).where(eq(clientUsers.email, email)).get()
    if (exists) return { ok: false, error: '该邮箱已注册' }

    if (requireVerify) {
      if (!code) return { ok: false, error: '请输入邮箱验证码' }
      if (!this.checkCode(email, code)) return { ok: false, error: '验证码错误或已过期' }
    }

    const res = this.db
      .insert(clientUsers)
      .values({
        tenant,
        email,
        passwordHash: hashPassword(password),
        verified: requireVerify ? 1 : 0,
        createdAt: Date.now()
      })
      .run()
    const user: ClientUser = {
      id: Number(res.lastInsertRowid),
      tenant,
      email,
      verified: requireVerify,
      role: 'boss',
      permissions: [...CLIENT_ROLE_PRESETS.boss!]
    }
    return { ok: true, token: this.createSession(user.id), user }
  }

  login(email: string, password: string): { token: string; user: ClientUser } | null {
    const row = this.db.select().from(clientUsers).where(eq(clientUsers.email, email)).get()
    if (!row) return null
    if (!verifyPassword(password, row.passwordHash)) return null
    // 被停用的子账号不能登录 —— 客服离职后老板一键停用即可
    if (row.enabled !== 1) return null
    return { token: this.createSession(row.id), user: this.hydrate(row) }
  }

  /** 解析会话令牌 → 客户端用户（同步鉴权用）；无效/过期返回 null */
  resolve(token: string): ClientUser | null {
    const s = this.db.select().from(clientSessions).where(eq(clientSessions.token, token)).get()
    if (!s || s.expiresAt < Date.now()) return null
    const u = this.db.select().from(clientUsers).where(eq(clientUsers.id, s.userId)).get()
    if (!u || u.enabled !== 1) return null
    return this.hydrate(u)
  }

  /** 补齐有效权限：内置预设或老板自定义角色 ∪ 直接分配 */
  private hydrate(row: Row): ClientUser {
    const rolePerms =
      CLIENT_ROLE_PRESETS[row.role] ??
      this.rolePermissions(row.tenant, row.role) ??
      []
    let extra: string[] = []
    try {
      const parsed = JSON.parse(row.permissions)
      if (Array.isArray(parsed)) extra = parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      extra = []
    }
    return { ...baseUser(row), permissions: effectiveClientPermissions([...rolePerms], extra) }
  }

  private rolePermissions(tenant: string, roleId: string): string[] | null {
    const r = this.db
      .select()
      .from(clientRoles)
      .where(and(eq(clientRoles.tenant, tenant), eq(clientRoles.id, roleId)))
      .get()
    if (!r) return null
    try {
      const parsed = JSON.parse(r.permissions)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  // ══════════ 团队管理（老板 → 子账号） ══════════

  /**
   * 老板创建子账号。权限收敛校验在此：分配的角色/权限必须 ⊆ 老板自己的。
   */
  createMember(
    owner: ClientUser,
    email: string,
    password: string,
    role: string
  ): { ok: true; member: TeamMember } | { ok: false; error: string } {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: '邮箱格式不正确' }
    if (password.length < 8) return { ok: false, error: '密码至少 8 位' }
    const rolePerms =
      role === 'agent'
        ? []
        : role === 'boss'
          ? null // 不允许建同级 boss 子账号
          : this.rolePermissions(owner.tenant, role)
    if (rolePerms === null) return { ok: false, error: '角色不存在或不可分配' }
    if (!canDelegate(owner.permissions, rolePerms)) {
      return { ok: false, error: '不能分配超出自己权限的角色' }
    }
    const normalized = email.trim().toLowerCase()
    try {
      const res = this.db
        .insert(clientUsers)
        .values({
          tenant: owner.tenant,
          email: normalized,
          passwordHash: hashPassword(password),
          verified: 1,
          ownerId: owner.id,
          role,
          permissions: '[]',
          enabled: 1,
          createdAt: Date.now()
        })
        .run()
      const id = Number(res.lastInsertRowid)
      return {
        ok: true,
        member: {
          id,
          email: normalized,
          role,
          roleName: this.roleName(owner.tenant, role),
          permissions: rolePerms,
          enabled: true,
          createdAt: Date.now()
        }
      }
    } catch {
      return { ok: false, error: '该邮箱已被注册' }
    }
  }

  listMembers(owner: ClientUser): TeamMember[] {
    return this.db
      .select()
      .from(clientUsers)
      .where(and(eq(clientUsers.tenant, owner.tenant), eq(clientUsers.ownerId, owner.id)))
      .all()
      .map((r) => {
        const u = this.hydrate(r)
        return {
          id: r.id,
          email: r.email,
          role: r.role,
          roleName: this.roleName(owner.tenant, r.role),
          permissions: u.permissions,
          enabled: r.enabled === 1,
          createdAt: r.createdAt
        }
      })
  }

  /** 只能改自己名下的子账号；角色变更同样过委派校验 */
  updateMember(
    owner: ClientUser,
    memberId: number,
    patch: { role?: string; enabled?: boolean; password?: string }
  ): { ok: true } | { ok: false; error: string } {
    const row = this.db
      .select()
      .from(clientUsers)
      .where(and(eq(clientUsers.id, memberId), eq(clientUsers.ownerId, owner.id)))
      .get()
    if (!row) return { ok: false, error: '子账号不存在' }
    const set: Record<string, unknown> = {}
    if (patch.role !== undefined) {
      const perms =
        patch.role === 'agent' ? [] : patch.role === 'boss' ? null : this.rolePermissions(owner.tenant, patch.role)
      if (perms === null) return { ok: false, error: '角色不存在或不可分配' }
      if (!canDelegate(owner.permissions, perms)) {
        return { ok: false, error: '不能分配超出自己权限的角色' }
      }
      set.role = patch.role
    }
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
    if (patch.password) {
      if (patch.password.length < 8) return { ok: false, error: '密码至少 8 位' }
      set.passwordHash = hashPassword(patch.password)
    }
    if (Object.keys(set).length === 0) return { ok: true }
    this.db.update(clientUsers).set(set).where(eq(clientUsers.id, memberId)).run()
    // 停用或改密后吊销其会话
    if (patch.enabled === false || patch.password) {
      this.db.delete(clientSessions).where(eq(clientSessions.userId, memberId)).run()
    }
    return { ok: true }
  }

  // ── 自定义角色 ──

  createRole(
    owner: ClientUser,
    name: string,
    permissions: string[]
  ): { ok: true; role: ClientRole } | { ok: false; error: string } {
    const perms = permissions.filter(isClientPermission)
    if (!canDelegate(owner.permissions, perms)) {
      return { ok: false, error: '不能创建超出自己权限的角色' }
    }
    const id = randomUUID()
    this.db
      .insert(clientRoles)
      .values({
        tenant: owner.tenant,
        id,
        ownerId: owner.id,
        name,
        permissions: JSON.stringify(perms),
        createdAt: Date.now()
      })
      .run()
    return { ok: true, role: { id, name, permissions: perms } }
  }

  listRoles(owner: ClientUser): ClientRole[] {
    return this.db
      .select()
      .from(clientRoles)
      .where(and(eq(clientRoles.tenant, owner.tenant), eq(clientRoles.ownerId, owner.id)))
      .all()
      .map((r) => {
        let perms: string[] = []
        try {
          const parsed = JSON.parse(r.permissions)
          if (Array.isArray(parsed)) perms = parsed.filter((x): x is string => typeof x === 'string')
        } catch {
          perms = []
        }
        return { id: r.id, name: r.name, permissions: perms }
      })
  }

  deleteRole(owner: ClientUser, roleId: string): { ok: boolean; error?: string } {
    // 有子账号在用的角色不能删 —— 删了他们的权限会悄悄变空
    const inUse = this.db
      .select({ id: clientUsers.id })
      .from(clientUsers)
      .where(and(eq(clientUsers.ownerId, owner.id), eq(clientUsers.role, roleId)))
      .get()
    if (inUse) return { ok: false, error: '仍有子账号使用该角色，请先改配他们的角色' }
    const res = this.db
      .delete(clientRoles)
      .where(
        and(
          eq(clientRoles.tenant, owner.tenant),
          eq(clientRoles.id, roleId),
          eq(clientRoles.ownerId, owner.id)
        )
      )
      .run()
    return { ok: res.changes > 0 }
  }

  private roleName(tenant: string, role: string): string {
    if (role === 'boss') return '老板'
    if (role === 'agent') return '客服'
    const r = this.db
      .select({ name: clientRoles.name })
      .from(clientRoles)
      .where(and(eq(clientRoles.tenant, tenant), eq(clientRoles.id, role)))
      .get()
    return r?.name ?? role
  }

  /** 注册时间（公告受众"新用户"求值用） */
  registeredAt(userId: number): number | undefined {
    const r = this.db
      .select({ createdAt: clientUsers.createdAt })
      .from(clientUsers)
      .where(eq(clientUsers.id, userId))
      .get()
    return r?.createdAt
  }

  /** 按用户 id 取邮箱（到期提醒发邮件用） */
  emailOf(userId: number): string | undefined {
    const r = this.db
      .select({ email: clientUsers.email })
      .from(clientUsers)
      .where(eq(clientUsers.id, userId))
      .get()
    return r?.email
  }

  /** 该邮箱是否已注册（找回密码发码前的静默检查） */
  hasUser(email: string): boolean {
    return !!this.db
      .select({ x: clientUsers.id })
      .from(clientUsers)
      .where(eq(clientUsers.email, email.trim().toLowerCase()))
      .get()
  }

  /**
   * 用邮箱验证码重置密码。
   * 成功后**吊销该用户的全部会话** —— 重置密码的常见动机就是"账号可能被盗"，
   * 留着旧会话等于白改。
   */
  resetPassword(
    email: string,
    code: string,
    newPassword: string
  ): { ok: true } | { ok: false; error: string } {
    const normalized = email.trim().toLowerCase()
    if (newPassword.length < 8) return { ok: false, error: '密码至少 8 位' }
    const user = this.db
      .select()
      .from(clientUsers)
      .where(eq(clientUsers.email, normalized))
      .get()
    // 先验码再判用户存在与否，两种失败返回同一句话，不泄露邮箱是否注册
    if (!this.checkCode(normalized, code) || !user) {
      return { ok: false, error: '验证码错误或已过期' }
    }
    this.db
      .update(clientUsers)
      .set({ passwordHash: hashPassword(newPassword) })
      .where(eq(clientUsers.id, user.id))
      .run()
    this.db.delete(clientSessions).where(eq(clientSessions.userId, user.id)).run()
    return { ok: true }
  }

  logout(token: string): void {
    this.db.delete(clientSessions).where(eq(clientSessions.token, token)).run()
  }

  private createSession(userId: number): string {
    const token = newSessionToken()
    this.db
      .insert(clientSessions)
      .values({ token, userId, expiresAt: Date.now() + SESSION_TTL_MS })
      .run()
    return token
  }

  pruneCodes(): void {
    this.db.delete(emailCodes).where(lt(emailCodes.expiresAt, Date.now())).run()
    this.db.delete(clientSessions).where(lt(clientSessions.expiresAt, Date.now())).run()
  }
}

type Row = typeof clientUsers.$inferSelect
function baseUser(r: Row): Omit<ClientUser, 'permissions'> {
  return {
    id: r.id,
    tenant: r.tenant,
    email: r.email,
    verified: r.verified === 1,
    ownerId: r.ownerId ?? undefined,
    role: r.role
  }
}

/** node:crypto 随机 [0,1) */
function secureRand(): number {
  return randomBytes(4).readUInt32BE(0) / 0xffffffff
}
