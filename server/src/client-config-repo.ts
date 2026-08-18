import { and, eq } from 'drizzle-orm'
import type { Db } from './db.ts'
import { clientConfigs } from './schema.ts'

export interface ClientConfig {
  blob: Record<string, unknown>
  updatedAt: number
}

/**
 * 客户端配置云同步仓库（跨设备漫游非敏感偏好）。
 *
 * 红线：blob 只应包含偏好白名单（语言/主题/翻译偏好/通知/自动回复话术等），
 * 绝不含平台凭证、会话、代理或登录令牌 —— 白名单过滤在客户端做，这里只负责存取。
 * 冲突策略：后写为准（put 的 updatedAt 更大才覆盖），避免旧设备用陈旧数据回冲。
 */
export class ClientConfigRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  get(tenant: string, userId: number): ClientConfig | null {
    const row = this.db
      .select()
      .from(clientConfigs)
      .where(and(eq(clientConfigs.tenant, tenant), eq(clientConfigs.userId, userId)))
      .get()
    if (!row) return null
    let blob: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(row.blob)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        blob = parsed as Record<string, unknown>
      }
    } catch {
      blob = {}
    }
    return { blob, updatedAt: row.updatedAt }
  }

  /**
   * 后写为准：仅当传入 updatedAt 严格大于已存时才覆盖。
   * 返回落库后的当前值（无论本次是否覆盖），方便客户端对齐。
   */
  put(tenant: string, userId: number, blob: Record<string, unknown>, updatedAt: number): ClientConfig {
    const existing = this.get(tenant, userId)
    if (existing && updatedAt <= existing.updatedAt) return existing
    const serialized = JSON.stringify(blob ?? {})
    this.db
      .insert(clientConfigs)
      .values({ tenant, userId, blob: serialized, updatedAt })
      .onConflictDoUpdate({
        target: [clientConfigs.tenant, clientConfigs.userId],
        set: { blob: serialized, updatedAt }
      })
      .run()
    return { blob: blob ?? {}, updatedAt }
  }
}
