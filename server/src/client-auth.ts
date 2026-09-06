import { randomBytes } from 'node:crypto'
import { and, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { hashPassword, newSessionToken, verifyPassword } from './auth.ts'
import type { Db } from './db.ts'
import { randomUUID } from 'node:crypto'
import { clientConfigs, clientRoles, clientSessions, clientUsers, emailCodes, inviteCodes, referrals } from './schema.ts'
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

/** 管理后台查看的桌面端注册用户摘要；不返回密码哈希或会话令牌。 */
export interface RegisteredUserAdmin {
  id: number
  tenant: string
  email: string
  verified: boolean
  ownerId?: number
  role: string
  enabled: boolean
  createdAt: number
}

export type RegisterResult =
  | { ok: true; token: string; user: ClientUser }
  | { ok: false; error: string }

/** 登录时客户端上报的设备信息（都可空，老客户端不带） */
export interface DeviceInfo {
  deviceId?: string
  deviceName?: string
}

/** 一台设备的聚合视图（远程下线用；不含令牌） */
export interface DeviceSummary {
  deviceId: string
  deviceName: string
  lastSeenAt: number
  firstSeenAt: number
  /** 该设备当前活跃会话数 */
  sessions: number
  /** 是否为发起本次请求的设备 */
  current: boolean
}

export type LoginResult =
  | { token: string; user: ClientUser }
  | null
  | { deviceLimit: true; maxDevices: number; devices: DeviceSummary[] }

/** 客户端用户（桌面端账号）认证：注册/登录/邮箱验证码。 */
export class ClientAuthRepo {
  private readonly db: Db

  /**
   * 设备上限解析器：给出计费主体（老板）的设备数上限，0 = 不限。
   * 由 server 注入 billing.deviceQuota，避免 auth 硬依赖 billing。
   */
  deviceQuotaResolver?: (billingOwnerId: number) => number

  constructor(db: Db) {
    this.db = db
  }

  // ══════════ 管理后台：注册用户 CRUD ══════════

  listAdminUsers(tenant: string): RegisteredUserAdmin[] {
    return this.db
      .select()
      .from(clientUsers)
      .where(eq(clientUsers.tenant, tenant))
      .all()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toRegisteredUserAdmin)
  }

  createAdminUser(
    tenant: string,
    email: string,
    password: string,
    verified = true
  ): { ok: true; user: RegisteredUserAdmin } | { ok: false; error: string } {
    const normalized = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return { ok: false, error: '邮箱格式不正确' }
    if (password.length < 6) return { ok: false, error: '密码至少 6 位' }
    try {
      const res = this.db
        .insert(clientUsers)
        .values({
          tenant,
          email: normalized,
          passwordHash: hashPassword(password),
          verified: verified ? 1 : 0,
          ownerId: null,
          role: 'boss',
          permissions: '[]',
          enabled: 1,
          createdAt: Date.now()
        })
        .run()
      const row = this.db.select().from(clientUsers).where(eq(clientUsers.id, Number(res.lastInsertRowid))).get()
      return row ? { ok: true, user: toRegisteredUserAdmin(row) } : { ok: false, error: '创建用户失败' }
    } catch {
      return { ok: false, error: '该邮箱已注册' }
    }
  }

  updateAdminUser(
    tenant: string,
    id: number,
    patch: { email?: string; password?: string; enabled?: boolean; verified?: boolean }
  ): { ok: true } | { ok: false; error: string } {
    const row = this.db
      .select()
      .from(clientUsers)
      .where(and(eq(clientUsers.tenant, tenant), eq(clientUsers.id, id)))
      .get()
    if (!row) return { ok: false, error: '用户不存在' }
    const set: Record<string, unknown> = {}
    if (patch.email !== undefined) {
      const email = patch.email.trim().toLowerCase()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: '邮箱格式不正确' }
      set.email = email
    }
    if (patch.password !== undefined) {
      if (patch.password.length < 6) return { ok: false, error: '密码至少 6 位' }
      set.passwordHash = hashPassword(patch.password)
    }
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
    if (patch.verified !== undefined) set.verified = patch.verified ? 1 : 0
    try {
      if (Object.keys(set).length) this.db.update(clientUsers).set(set).where(eq(clientUsers.id, id)).run()
    } catch {
      return { ok: false, error: '该邮箱已被占用' }
    }
    if (patch.enabled === false || patch.password !== undefined) {
      this.db.delete(clientSessions).where(eq(clientSessions.userId, id)).run()
    }
    return { ok: true }
  }

  deleteAdminUser(tenant: string, id: number): { ok: true } | { ok: false; error: string } {
    const row = this.db
      .select({ id: clientUsers.id })
      .from(clientUsers)
      .where(and(eq(clientUsers.tenant, tenant), eq(clientUsers.id, id)))
      .get()
    if (!row) return { ok: false, error: '用户不存在' }
    const child = this.db
      .select({ id: clientUsers.id })
      .from(clientUsers)
      .where(and(eq(clientUsers.tenant, tenant), eq(clientUsers.ownerId, id)))
      .get()
    if (child) return { ok: false, error: '该用户仍有子账号，请先处理子账号' }
    this.db.delete(clientSessions).where(eq(clientSessions.userId, id)).run()
    this.db.delete(clientConfigs).where(and(eq(clientConfigs.tenant, tenant), eq(clientConfigs.userId, id))).run()
    this.db.delete(clientRoles).where(and(eq(clientRoles.tenant, tenant), eq(clientRoles.ownerId, id))).run()
    this.db.delete(clientUsers).where(and(eq(clientUsers.tenant, tenant), eq(clientUsers.id, id))).run()
    return { ok: true }
  }

  /** 生成并存储验证码（6 位数字），返回验证码供发信 */
  issueCode(email: string, fixed?: string): string {
    // 开发模式（未配 SMTP）传入固定码，方便测试；线上永远随机 6 位不可预测
    const code = fixed ?? String(Math.floor(100000 + secureRand() * 900000))
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
    requireVerify: boolean,
    device?: DeviceInfo,
    inviteCode?: string
  ): RegisterResult {
    const normalizedEmail = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
      return { ok: false, error: '邮箱格式不正确' }
    }
    if (password.length < 6) return { ok: false, error: '密码至少 6 位' }

    const exists = this.db.select().from(clientUsers).where(eq(clientUsers.email, normalizedEmail)).get()
    if (exists) return { ok: false, error: '该邮箱已注册' }

    if (requireVerify) {
      if (!code) return { ok: false, error: '请输入邮箱验证码' }
      if (!this.checkCode(normalizedEmail, code)) return { ok: false, error: '验证码错误或已过期' }
    }
    const normalizedInvite = inviteCode?.trim().toUpperCase().replace(/[\s-]+/g, '') || ''
    if (normalizedInvite && !/^[A-Z0-9]{6,24}$/.test(normalizedInvite)) {
      return { ok: false, error: '邀请码格式不正确' }
    }

    const now = Date.now()
    let userId = 0
    try {
      userId = this.db.transaction((tx) => {
        let invite: typeof inviteCodes.$inferSelect | undefined
        if (normalizedInvite) {
          invite = tx
            .select()
            .from(inviteCodes)
            .where(and(eq(inviteCodes.tenant, tenant), eq(inviteCodes.code, normalizedInvite)))
            .get()
          if (!invite || invite.enabled !== 1) throw new Error('INVITE_DISABLED')
          if (invite.expiresAt != null && invite.expiresAt <= now) throw new Error('INVITE_EXPIRED')
          if (invite.maxUses > 0 && invite.usedCount >= invite.maxUses) throw new Error('INVITE_FULL')
        }

        const res = tx
          .insert(clientUsers)
          .values({
            tenant,
            email: normalizedEmail,
            passwordHash: hashPassword(password),
            verified: requireVerify ? 1 : 0,
            createdAt: now
          })
          .run()
        const id = Number(res.lastInsertRowid)
        if (invite) {
          tx.insert(referrals).values({
            tenant,
            inviteeUserId: id,
            inviterUserId: invite.inviterUserId,
            inviteCode: invite.code,
            createdAt: now
          }).run()
          tx.update(inviteCodes)
            .set({ usedCount: sql`${inviteCodes.usedCount} + 1`, updatedAt: now })
            .where(and(eq(inviteCodes.tenant, tenant), eq(inviteCodes.code, invite.code)))
            .run()
        }
        return id
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === 'INVITE_DISABLED') return { ok: false, error: '邀请码不存在或已停用' }
      if (message === 'INVITE_EXPIRED') return { ok: false, error: '邀请码已过期' }
      if (message === 'INVITE_FULL') return { ok: false, error: '邀请码使用次数已满' }
      return { ok: false, error: '注册失败，请稍后重试' }
    }
    const user: ClientUser = {
      id: userId,
      tenant,
      email: normalizedEmail,
      verified: requireVerify,
      role: 'boss',
      permissions: [...CLIENT_ROLE_PRESETS.boss!]
    }
    // 新注册的老板尚无订阅，不做设备限制，只记录设备信息
    return { ok: true, token: this.createSession(user.id, device), user }
  }

  login(email: string, password: string, device?: DeviceInfo): LoginResult {
    const normalized = email.trim().toLowerCase()
    const row = this.db.select().from(clientUsers).where(eq(clientUsers.email, normalized)).get()
    if (!row) return null
    if (!verifyPassword(password, row.passwordHash)) return null
    // 被停用的子账号不能登录 —— 客服离职后老板一键停用即可
    if (row.enabled !== 1) return null

    const user = this.hydrate(row)
    // 设备上限：仅在客户端上报了 deviceId 且计费主体设了正数上限时生效
    const limit = this.enforceDeviceLimit(user, device?.deviceId)
    if (limit) return limit

    return { token: this.createSession(row.id, device), user }
  }

  /**
   * 计费主体（老板）名下所有用户共享同一设备池。返回被拒信息或 null（放行）。
   * 已知设备重复登录不占新名额；未知设备在已达上限时被拒，改由远程下线腾位。
   */
  private enforceDeviceLimit(
    user: ClientUser,
    deviceId: string | undefined
  ): { deviceLimit: true; maxDevices: number; devices: DeviceSummary[] } | null {
    if (!deviceId) return null // 无法识别的设备不纳入管控（老客户端），放行
    const ownerId = user.ownerId ?? user.id
    const quota = this.deviceQuotaResolver?.(ownerId) ?? 0
    if (quota <= 0) return null // 0 = 不限
    const active = this.activeDeviceIds(this.groupUserIds(ownerId))
    if (active.has(deviceId)) return null // 已在册设备，直接放行
    if (active.size < quota) return null // 还有名额
    return { deviceLimit: true, maxDevices: quota, devices: this.listDevicesForOwner(ownerId) }
  }

  /** 解析会话令牌 → 客户端用户（同步鉴权用）；无效/过期返回 null */
  resolve(token: string): ClientUser | null {
    const s = this.db.select().from(clientSessions).where(eq(clientSessions.token, token)).get()
    if (!s || s.expiresAt < Date.now()) return null
    const u = this.db.select().from(clientUsers).where(eq(clientUsers.id, s.userId)).get()
    if (!u || u.enabled !== 1) return null
    // 节流刷新最近活跃（>60s 才写，避免每个请求都落盘）
    const now = Date.now()
    if (s.deviceId && (s.lastSeenAt == null || now - s.lastSeenAt > 60_000)) {
      this.db
        .update(clientSessions)
        .set({ lastSeenAt: now })
        .where(eq(clientSessions.token, token))
        .run()
    }
    return this.hydrate(u)
  }

  // ══════════ 设备管理（一个订阅限 N 台 + 远程下线） ══════════

  /** 计费主体名下的全部用户 id（老板本人 + 其子账号），共享设备池 */
  private groupUserIds(ownerId: number): number[] {
    const subs = this.db
      .select({ id: clientUsers.id })
      .from(clientUsers)
      .where(eq(clientUsers.ownerId, ownerId))
      .all()
      .map((r) => r.id)
    return [ownerId, ...subs]
  }

  /** 一组用户当前活跃（未过期）会话里出现过的去重 deviceId 集合 */
  private activeDeviceIds(userIds: number[]): Set<string> {
    if (userIds.length === 0) return new Set()
    const rows = this.db
      .select({ deviceId: clientSessions.deviceId })
      .from(clientSessions)
      .where(
        and(
          inArray(clientSessions.userId, userIds),
          gt(clientSessions.expiresAt, Date.now()),
          isNotNull(clientSessions.deviceId)
        )
      )
      .all()
    return new Set(rows.map((r) => r.deviceId!).filter(Boolean))
  }

  /** 计费主体的设备列表（聚合去重，不含令牌） */
  private listDevicesForOwner(ownerId: number, currentToken?: string): DeviceSummary[] {
    const now = Date.now()
    const rows = this.db
      .select()
      .from(clientSessions)
      .where(
        and(
          inArray(clientSessions.userId, this.groupUserIds(ownerId)),
          gt(clientSessions.expiresAt, now),
          isNotNull(clientSessions.deviceId)
        )
      )
      .all()
    const byDevice = new Map<string, DeviceSummary>()
    for (const r of rows) {
      const id = r.deviceId!
      const seen = r.lastSeenAt ?? r.createdAt ?? 0
      const first = r.createdAt ?? seen
      const prev = byDevice.get(id)
      if (!prev) {
        byDevice.set(id, {
          deviceId: id,
          deviceName: r.deviceName ?? '未知设备',
          lastSeenAt: seen,
          firstSeenAt: first,
          sessions: 1,
          current: r.token === currentToken
        })
      } else {
        prev.sessions += 1
        if (seen > prev.lastSeenAt) {
          prev.lastSeenAt = seen
          if (r.deviceName) prev.deviceName = r.deviceName
        }
        if (first < prev.firstSeenAt) prev.firstSeenAt = first
        if (r.token === currentToken) prev.current = true
      }
    }
    return [...byDevice.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /** 列出「我」所属计费主体的全部设备（当前设备标记 current） */
  listDevices(user: ClientUser, currentToken?: string): DeviceSummary[] {
    return this.listDevicesForOwner(user.ownerId ?? user.id, currentToken)
  }

  /**
   * 远程下线：吊销某设备在本计费主体名下的全部会话。
   * 只能下线同一计费主体的设备（跨老板隔离）。返回被吊销的会话数。
   */
  revokeDevice(user: ClientUser, deviceId: string): number {
    if (!deviceId) return 0
    const res = this.db
      .delete(clientSessions)
      .where(
        and(
          inArray(clientSessions.userId, this.groupUserIds(user.ownerId ?? user.id)),
          eq(clientSessions.deviceId, deviceId)
        )
      )
      .run()
    return res.changes
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
   *
   * 登录名格式：`<用户名>@<老板id>`。老板只填 @ 前面的用户名（仅字母数字），
   * 后缀由系统拼接 —— 子账号天然按老板隔离，绝不会与其他老板的
   * 真实邮箱或子账号撞名（真实邮箱域名必含点号，这里的后缀是纯数字）。
   */
  createMember(
    owner: ClientUser,
    username: string,
    password: string,
    role: string
  ): { ok: true; member: TeamMember } | { ok: false; error: string } {
    const uname = username.trim().toLowerCase()
    if (!/^[a-z0-9]{2,32}$/.test(uname)) {
      return { ok: false, error: '用户名只能是 2-32 位字母或数字（@ 后缀由系统添加）' }
    }
    const email = `${uname}@${owner.id}`
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
    try {
      const res = this.db
        .insert(clientUsers)
        .values({
          tenant: owner.tenant,
          email,
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
          email,
          role,
          roleName: this.roleName(owner.tenant, role),
          permissions: rolePerms,
          enabled: true,
          createdAt: Date.now()
        }
      }
    } catch {
      return { ok: false, error: '该用户名已被占用' }
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

  /** 删除子账号：吊销其全部会话后删行。只能删自己名下的。 */
  deleteMember(owner: ClientUser, memberId: number): { ok: boolean; error?: string } {
    const row = this.db
      .select({ id: clientUsers.id })
      .from(clientUsers)
      .where(and(eq(clientUsers.id, memberId), eq(clientUsers.ownerId, owner.id)))
      .get()
    if (!row) return { ok: false, error: '子账号不存在' }
    this.db.delete(clientSessions).where(eq(clientSessions.userId, memberId)).run()
    this.db.delete(clientUsers).where(eq(clientUsers.id, memberId)).run()
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
  /** 邮箱 → 用户 id（管理后台手动调余额时用邮箱定位用户） */
  userIdOf(email: string): number | undefined {
    const r = this.db
      .select({ id: clientUsers.id })
      .from(clientUsers)
      .where(eq(clientUsers.email, email.trim().toLowerCase()))
      .get()
    return r?.id
  }

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

  private createSession(userId: number, device?: DeviceInfo): string {
    const token = newSessionToken()
    const now = Date.now()
    this.db
      .insert(clientSessions)
      .values({
        token,
        userId,
        expiresAt: now + SESSION_TTL_MS,
        deviceId: device?.deviceId?.slice(0, 128) ?? null,
        deviceName: device?.deviceName?.slice(0, 128) ?? null,
        lastSeenAt: now,
        createdAt: now
      })
      .run()
    return token
  }

  pruneCodes(): void {
    this.db.delete(emailCodes).where(lt(emailCodes.expiresAt, Date.now())).run()
    this.db.delete(clientSessions).where(lt(clientSessions.expiresAt, Date.now())).run()
  }
}

type Row = typeof clientUsers.$inferSelect
function toRegisteredUserAdmin(r: Row): RegisteredUserAdmin {
  return {
    id: r.id,
    tenant: r.tenant,
    email: r.email,
    verified: r.verified === 1,
    ownerId: r.ownerId ?? undefined,
    role: r.role,
    enabled: r.enabled === 1,
    createdAt: r.createdAt
  }
}

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
