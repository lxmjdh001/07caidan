import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from './db.ts'
import { lineAccounts, lineEvents } from './schema.ts'

/**
 * LINE Webhook 中转：LINE 只支持公网 Webhook 收信，客户端无法直连。
 * 客户端把 channelSecret 注册到这里；LINE 事件经 Webhook 进队列；客户端轮询拉取。
 */
export class LineRelay {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  register(tenant: string, accountId: string, channelSecret: string): void {
    this.db
      .insert(lineAccounts)
      .values({ tenant, accountId, channelSecret, createdAt: Date.now() })
      .onConflictDoUpdate({
        target: [lineAccounts.tenant, lineAccounts.accountId],
        set: { channelSecret }
      })
      .run()
  }

  /** 找出某 accountId 对应的租户与密钥（Webhook 路由用） */
  lookup(tenant: string, accountId: string): { channelSecret: string } | null {
    const row = this.db
      .select()
      .from(lineAccounts)
      .where(and(eq(lineAccounts.tenant, tenant), eq(lineAccounts.accountId, accountId)))
      .get()
    return row ? { channelSecret: row.channelSecret } : null
  }

  /** 验证 LINE Webhook 签名（HMAC-SHA256, base64） */
  verifySignature(channelSecret: string, rawBody: string, signature: string): boolean {
    const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64')
    const a = Buffer.from(expected)
    const b = Buffer.from(signature || '')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** 入队一批事件 */
  enqueue(tenant: string, accountId: string, events: unknown[]): void {
    const now = Date.now()
    for (const ev of events) {
      this.db
        .insert(lineEvents)
        .values({ tenant, accountId, payload: JSON.stringify(ev), createdAt: now })
        .run()
    }
  }

  /** 拉取并清空某账号的待处理事件 */
  pull(tenant: string, accountId: string, limit = 100): unknown[] {
    const rows = this.db
      .select()
      .from(lineEvents)
      .where(and(eq(lineEvents.tenant, tenant), eq(lineEvents.accountId, accountId)))
      .orderBy(asc(lineEvents.id))
      .limit(limit)
      .all()
    if (rows.length === 0) return []
    this.db
      .delete(lineEvents)
      .where(inArray(lineEvents.id, rows.map((r) => r.id)))
      .run()
    return rows.map((r) => JSON.parse(r.payload))
  }
}
