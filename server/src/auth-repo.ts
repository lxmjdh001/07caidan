import { and, eq, lt } from 'drizzle-orm'
import {
  effectivePermissions,
  hashPassword,
  newSessionToken,
  ROLE_PRESETS,
  verifyPassword,
  type Permission
} from './auth.ts'
import type { Db } from './db.ts'
import { adminUsers, sessions } from './schema.ts'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface AuthUser {
  id: number
  tenant: string
  username: string
  role: string
  /** 直接分配的额外权限 */
  permissions: string[]
  enabled: boolean
}

export interface Principal {
  userId: number
  tenant: string
  username: string
  role: string
  /** 有效权限（角色预设 + 额外分配） */
  permissions: Permission[]
}

/** 管理后台用户/会话数据访问 + RBAC。 */
export class AuthRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  /** 首次运行且无用户时，用配置里的账号创建 owner */
  bootstrap(tenant: string, username: string, password: string): void {
    const count = this.db.select({ id: adminUsers.id }).from(adminUsers).all().length
    if (count > 0) return
    this.createUser(tenant, username, password, 'owner', [])
  }

  createUser(
    tenant: string,
    username: string,
    password: string,
    role: string,
    permissions: string[]
  ): AuthUser {
    const now = Date.now()
    const res = this.db
      .insert(adminUsers)
      .values({
        tenant,
        username,
        passwordHash: hashPassword(password),
        role,
        permissions: JSON.stringify(permissions),
        enabled: 1,
        createdAt: now
      })
      .run()
    return {
      id: Number(res.lastInsertRowid),
      tenant,
      username,
      role,
      permissions,
      enabled: true
    }
  }

  listUsers(tenant: string): AuthUser[] {
    return this.db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.tenant, tenant))
      .all()
      .map(toUser)
  }

  updateUser(
    tenant: string,
    id: number,
    patch: { role?: string; permissions?: string[]; enabled?: boolean; password?: string }
  ): boolean {
    const set: Record<string, unknown> = {}
    if (patch.role !== undefined) set.role = patch.role
    if (patch.permissions !== undefined) set.permissions = JSON.stringify(patch.permissions)
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
    if (patch.password) set.passwordHash = hashPassword(patch.password)
    if (Object.keys(set).length === 0) return false
    const res = this.db
      .update(adminUsers)
      .set(set)
      .where(and(eq(adminUsers.tenant, tenant), eq(adminUsers.id, id)))
      .run()
    // 改密或停用后吊销该用户已发出的全部会话：改密的动机常是"号可能被盗"，留着旧会话等于白改；
    // 停用虽在 resolve 时也会被 enabled 挡下，但一并删掉更干净、也不留可复活的悬空会话。
    if (res.changes > 0 && (patch.password !== undefined || patch.enabled === false)) {
      this.db.delete(sessions).where(eq(sessions.userId, id)).run()
    }
    return res.changes > 0
  }

  deleteUser(tenant: string, id: number): boolean {
    const res = this.db
      .delete(adminUsers)
      .where(and(eq(adminUsers.tenant, tenant), eq(adminUsers.id, id)))
      .run()
    return res.changes > 0
  }

  /** 校验账号密码，成功则创建会话并返回 (token, principal) */
  login(username: string, password: string): { token: string; principal: Principal } | null {
    const row = this.db.select().from(adminUsers).where(eq(adminUsers.username, username)).get()
    if (!row || row.enabled !== 1) return null
    if (!verifyPassword(password, row.passwordHash)) return null

    const token = newSessionToken()
    this.db
      .insert(sessions)
      .values({ token, userId: row.id, expiresAt: Date.now() + SESSION_TTL_MS })
      .run()
    return { token, principal: toPrincipal(toUser(row)) }
  }

  logout(token: string): void {
    this.db.delete(sessions).where(eq(sessions.token, token)).run()
  }

  /** 用会话 token 解析出当前登录用户（过期/无效返回 null） */
  resolve(token: string): Principal | null {
    const s = this.db.select().from(sessions).where(eq(sessions.token, token)).get()
    if (!s || s.expiresAt < Date.now()) return null
    const u = this.db.select().from(adminUsers).where(eq(adminUsers.id, s.userId)).get()
    if (!u || u.enabled !== 1) return null
    return toPrincipal(toUser(u))
  }

  /** 清理过期会话（可定期调用） */
  pruneSessions(): void {
    this.db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run()
  }
}

type Row = typeof adminUsers.$inferSelect

function toUser(r: Row): AuthUser {
  let perms: string[] = []
  try {
    perms = JSON.parse(r.permissions)
  } catch {
    perms = []
  }
  return {
    id: r.id,
    tenant: r.tenant,
    username: r.username,
    role: r.role,
    permissions: perms,
    enabled: r.enabled === 1
  }
}

function toPrincipal(u: AuthUser): Principal {
  return {
    userId: u.id,
    tenant: u.tenant,
    username: u.username,
    role: u.role,
    permissions: effectivePermissions(u.role, u.permissions)
  }
}

export { ROLE_PRESETS }
