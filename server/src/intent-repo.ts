import { and, eq, inArray } from 'drizzle-orm'
import type { IntentAnalysis } from './analyzer.ts'
import type { Db } from './db.ts'
import { conversationIntent } from './schema.ts'

export interface StoredIntent {
  level: IntentAnalysis['intentLevel']
  summary: string
  signals: string[]
  suggestedAction: string
  analyzedAt: number
  lastInboundAt: number
}

/** 会话意向标签仓库：自动打标签结果落库，会话列表读取展示 */
export class IntentRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  get(tenant: string, conversationId: string): StoredIntent | null {
    const r = this.db
      .select()
      .from(conversationIntent)
      .where(and(eq(conversationIntent.tenant, tenant), eq(conversationIntent.conversationId, conversationId)))
      .get()
    if (!r) return null
    let signals: string[] = []
    try {
      const p = JSON.parse(r.signals)
      if (Array.isArray(p)) signals = p.filter((x): x is string => typeof x === 'string')
    } catch {
      signals = []
    }
    return {
      level: r.level as StoredIntent['level'],
      summary: r.summary,
      signals,
      suggestedAction: r.suggestedAction,
      analyzedAt: r.analyzedAt,
      lastInboundAt: r.lastInboundAt
    }
  }

  put(tenant: string, conversationId: string, analysis: IntentAnalysis, lastInboundAt: number, now = Date.now()): void {
    const row = {
      tenant,
      conversationId,
      level: analysis.intentLevel,
      summary: analysis.summary.slice(0, 2000),
      signals: JSON.stringify(analysis.signals ?? []),
      suggestedAction: analysis.suggestedAction.slice(0, 2000),
      analyzedAt: now,
      lastInboundAt
    }
    this.db
      .insert(conversationIntent)
      .values(row)
      .onConflictDoUpdate({
        target: [conversationIntent.tenant, conversationIntent.conversationId],
        set: { ...row }
      })
      .run()
  }

  /** 批量取多会话的意向等级，供会话列表一次性附加 */
  levelsFor(tenant: string, conversationIds: string[]): Map<string, StoredIntent['level']> {
    const out = new Map<string, StoredIntent['level']>()
    if (conversationIds.length === 0) return out
    // 分块避免 SQLite 变量上限
    for (let i = 0; i < conversationIds.length; i += 400) {
      const batch = conversationIds.slice(i, i + 400)
      const rows = this.db
        .select({ id: conversationIntent.conversationId, level: conversationIntent.level })
        .from(conversationIntent)
        .where(and(eq(conversationIntent.tenant, tenant), inArray(conversationIntent.conversationId, batch)))
        .all()
      for (const r of rows) out.set(r.id, r.level as StoredIntent['level'])
    }
    return out
  }

  /** 是否需要（重新）打标签：无记录或有更新的入站消息 */
  needsRetag(tenant: string, conversationId: string, newestInboundAt: number): boolean {
    if (newestInboundAt <= 0) return false // 没有入站消息不打
    const cur = this.get(tenant, conversationId)
    return !cur || cur.lastInboundAt < newestInboundAt
  }
}
