import { randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { hashPassword, newSessionToken, verifyPassword } from './auth.ts'
import type { Db } from './db.ts'
import { clientSessions, clientUsers, emailCodes } from './schema.ts'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const CODE_TTL_MS = 10 * 60 * 1000

export interface ClientUser {
  id: number
  tenant: string
  email: string
  verified: boolean
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
      verified: requireVerify
    }
    return { ok: true, token: this.createSession(user.id), user }
  }

  login(email: string, password: string): { token: string; user: ClientUser } | null {
    const row = this.db.select().from(clientUsers).where(eq(clientUsers.email, email)).get()
    if (!row) return null
    if (!verifyPassword(password, row.passwordHash)) return null
    return { token: this.createSession(row.id), user: toUser(row) }
  }

  /** 解析会话令牌 → 客户端用户（同步鉴权用）；无效/过期返回 null */
  resolve(token: string): ClientUser | null {
    const s = this.db.select().from(clientSessions).where(eq(clientSessions.token, token)).get()
    if (!s || s.expiresAt < Date.now()) return null
    const u = this.db.select().from(clientUsers).where(eq(clientUsers.id, s.userId)).get()
    return u ? toUser(u) : null
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
function toUser(r: Row): ClientUser {
  return { id: r.id, tenant: r.tenant, email: r.email, verified: r.verified === 1 }
}

/** node:crypto 随机 [0,1) */
function secureRand(): number {
  return randomBytes(4).readUInt32BE(0) / 0xffffffff
}
