import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** 全部权限点（管理后台可分配的最小粒度） */
export const PERMISSIONS = [
  'conversations:read', // 查看会话与聊天记录
  'analyze:run', // 运行 AI 意向分析
  'campaigns:manage', // 管理引流工单、分享链接与重粉库
  'billing:manage', // 管理套餐、支付通道、汇率、AI 供应商与用量
  'announcements:manage', // 发布运营公告与到期提醒配置
  'support:manage', // 查看与回复用户的支持工单
  'users:manage' // 管理后台用户与权限
] as const

export type Permission = (typeof PERMISSIONS)[number]

/** 角色预设 → 权限集合。用户实际权限 = 角色预设 ∪ 直接分配的权限。 */
export const ROLE_PRESETS: Record<string, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: ['conversations:read', 'analyze:run', 'campaigns:manage', 'billing:manage', 'announcements:manage', 'support:manage', 'users:manage'],
  agent: ['conversations:read', 'analyze:run', 'campaigns:manage', 'support:manage'],
  viewer: ['conversations:read']
}

export const ROLES = Object.keys(ROLE_PRESETS)

/** 计算用户有效权限（角色预设 + 额外分配，去重） */
export function effectivePermissions(role: string, extra: string[]): Permission[] {
  const set = new Set<Permission>(ROLE_PRESETS[role] ?? [])
  for (const p of extra) {
    if ((PERMISSIONS as readonly string[]).includes(p)) set.add(p as Permission)
  }
  return [...set]
}

/** scrypt 密码哈希：salt:hash（hex） */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), 32)
  const expected = Buffer.from(hashHex, 'hex')
  return hash.length === expected.length && timingSafeEqual(hash, expected)
}

export function newSessionToken(): string {
  return randomBytes(24).toString('hex')
}
