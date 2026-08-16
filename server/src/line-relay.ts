import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
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

  /**
   * 一次拉取本租户**全部账号**的待处理事件，按账号分组返回。
   *
   * 为什么要有它：客户端此前每个 LINE 账号各开一个 5 秒定时器单独拉，
   * 1000 个账号就是 200 req/s 的空轮询。改成客户端整机一个定时器
   * 调这里，请求量与账号数解耦（1000 账号 = 0.2 req/s）。
   */
  pullAll(tenant: string, limit = 500): Record<string, unknown[]> {
    const rows = this.db
      .select()
      .from(lineEvents)
      .where(eq(lineEvents.tenant, tenant))
      .orderBy(asc(lineEvents.id))
      .limit(limit)
      .all()
    if (rows.length === 0) return {}
    this.db
      .delete(lineEvents)
      .where(inArray(lineEvents.id, rows.map((r) => r.id)))
      .run()
    const out: Record<string, unknown[]> = {}
    for (const r of rows) {
      ;(out[r.accountId] ??= []).push(JSON.parse(r.payload))
    }
    return out
  }

  /**
   * 清理超龄事件。客户端长期离线时队列会无限堆积 ——
   * 三天没人拉的事件已经没有时效价值，直接丢弃。
   */
  pruneStale(tenant: string, maxAgeMs = 3 * 86_400_000, now = Date.now()): number {
    const res = this.db
      .delete(lineEvents)
      .where(and(eq(lineEvents.tenant, tenant), sql`${lineEvents.createdAt} < ${now - maxAgeMs}`))
      .run()
    return res.changes
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
