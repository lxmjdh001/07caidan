/**
 * 客户端权限体系（老板/客服分权）。
 *
 * 与后台管理的 RBAC 相互独立：这里管的是**桌面客户端里能看什么、做什么**。
 * 聊天是基础能力，不设权限点 —— 客服存在的意义就是聊天。
 */
export const CLIENT_PERMISSIONS = [
  'campaigns:manage', // 引流工单 / 重粉库 / 推广链接
  'billing:manage', // 套餐与余额（充值、订阅、流水）
  'accounts:manage', // 添加/删除平台账号、改代理与凭证
  'settings:manage', // 全局设置（翻译引擎 / AI / 自动回复话术）
  'team:manage' // 管理子账号与自定义角色
] as const

export type ClientPermission = (typeof CLIENT_PERMISSIONS)[number]

export function isClientPermission(v: string): v is ClientPermission {
  return (CLIENT_PERMISSIONS as readonly string[]).includes(v)
}

/** 内置角色预设。老板自定义角色存 client_roles 表，按 id 引用。 */
export const CLIENT_ROLE_PRESETS: Record<string, ClientPermission[]> = {
  boss: [...CLIENT_PERMISSIONS],
  agent: [] // 纯聊天
}

/**
 * 计算有效权限 = 角色权限 ∪ 直接分配。
 * rolePerms 由调用方解析（内置预设或自定义角色表）。
 */
export function effectiveClientPermissions(
  rolePerms: string[],
  extra: string[]
): ClientPermission[] {
  const set = new Set<ClientPermission>()
  for (const p of [...rolePerms, ...extra]) {
    if (isClientPermission(p)) set.add(p)
  }
  return [...set]
}

/**
 * 委派校验：分配出去的权限必须 ⊆ 分配者自己的权限。
 * 老板只有 boss 全集时这是恒真，但保留校验 ——
 * 将来若允许"高级客服"再往下建号，权限树必须收敛。
 */
export function canDelegate(granterPerms: string[], requested: string[]): boolean {
  const owned = new Set(granterPerms)
  return requested.every((p) => owned.has(p))
}
