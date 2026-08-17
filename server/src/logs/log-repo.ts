import { and, desc, eq, like, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { clientLogLevels, clientLogs } from '../schema.ts'

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export function isLogLevel(v: string): v is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(v)
}

/** 数值越大越严重；上报门槛按 >= 比较 */
export const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface LogEntryInput {
  level: string
  scope?: string
  message: string
  meta?: unknown
  at?: number
}

export interface DeviceInfo {
  deviceId: string
  appVersion?: string
  osType?: string
  osVersion?: string
}

export interface ClientLogRow {
  id: number
  userId: number | null
  deviceId: string
  level: string
  scope: string
  message: string
  meta: string | null
  appVersion: string
  osType: string
  osVersion: string
  at: number
  createdAt: number
}

/** 单条消息长度上限：日志不是聊天记录，超长直接截断 */
const MESSAGE_MAX = 2000
const META_MAX = 4000
/** 单次批量上报条数上限 */
export const BATCH_MAX = 200
/** 保留天数：排障用的日志没必要永久堆着 */
const RETAIN_MS = 14 * 24 * 3600_000

export class LogRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  /** 批量入库；非法级别的条目丢弃，返回实际入库数 */
  ingest(
    tenant: string,
    userId: number | undefined,
    device: DeviceInfo,
    entries: LogEntryInput[]
  ): number {
    const now = Date.now()
    let added = 0
    for (const e of entries.slice(0, BATCH_MAX)) {
      if (!e || typeof e.message !== 'string' || !isLogLevel(String(e.level))) continue
      let meta: string | null = null
      if (e.meta !== undefined) {
        try {
          meta = JSON.stringify(e.meta).slice(0, META_MAX)
        } catch {
          meta = null
        }
      }
      this.db
        .insert(clientLogs)
        .values({
          tenant,
          userId: userId ?? null,
          deviceId: device.deviceId,
          level: e.level,
          scope: typeof e.scope === 'string' ? e.scope.slice(0, 100) : '',
          message: e.message.slice(0, MESSAGE_MAX),
          meta,
          appVersion: (device.appVersion ?? '').slice(0, 50),
          osType: (device.osType ?? '').slice(0, 30),
          osVersion: (device.osVersion ?? '').slice(0, 60),
          at: typeof e.at === 'number' ? e.at : now,
          createdAt: now
        })
        .run()
      added++
    }
    return added
  }

  /** 该用户应上报的最低级别（管理未设置则默认 warn；游客恒为 warn） */
  levelFor(tenant: string, userId: number | undefined): LogLevel {
    if (userId === undefined) return 'warn'
    const r = this.db
      .select()
      .from(clientLogLevels)
      .where(and(eq(clientLogLevels.tenant, tenant), eq(clientLogLevels.userId, userId)))
      .get()
    return r && isLogLevel(r.level) ? r.level : 'warn'
  }

  setLevel(tenant: string, userId: number, level: LogLevel): void {
    this.db
      .insert(clientLogLevels)
      .values({ tenant, userId, level })
      .onConflictDoUpdate({
        target: [clientLogLevels.tenant, clientLogLevels.userId],
        set: { level }
      })
      .run()
  }

  listLevels(tenant: string): Array<{ userId: number; level: string }> {
    return this.db
      .select({ userId: clientLogLevels.userId, level: clientLogLevels.level })
      .from(clientLogLevels)
      .where(eq(clientLogLevels.tenant, tenant))
      .all()
  }

  list(
    tenant: string,
    filter: {
      level?: string
      userId?: number
      deviceId?: string
      q?: string
      limit?: number
    } = {}
  ): ClientLogRow[] {
    const conds = [eq(clientLogs.tenant, tenant)]
    if (filter.level && isLogLevel(filter.level)) {
      // 选中某级别 = 该级别及以上（看 warn 自然也想看 error）
      const wanted = LOG_LEVELS.filter((l) => LEVEL_RANK[l] >= LEVEL_RANK[filter.level as LogLevel])
      conds.push(or(...wanted.map((l) => eq(clientLogs.level, l)))!)
    }
    if (filter.userId !== undefined) conds.push(eq(clientLogs.userId, filter.userId))
    if (filter.deviceId) conds.push(eq(clientLogs.deviceId, filter.deviceId))
    if (filter.q) {
      conds.push(
        or(like(clientLogs.message, `%${filter.q}%`), like(clientLogs.scope, `%${filter.q}%`))!
      )
    }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
    return this.db
      .select()
      .from(clientLogs)
      .where(and(...conds))
      .orderBy(desc(clientLogs.createdAt), desc(clientLogs.id))
      .limit(limit)
      .all() as ClientLogRow[]
  }

  /** 概览：每个设备的最近上报（管理页顶部的设备/用户清单） */
  devices(tenant: string): Array<{
    deviceId: string
    userId: number | null
    appVersion: string
    osType: string
    osVersion: string
    lastAt: number
    total: number
    errors: number
  }> {
    return this.db
      .select({
        deviceId: clientLogs.deviceId,
        userId: sql<number | null>`max(${clientLogs.userId})`,
        appVersion: sql<string>`max(${clientLogs.appVersion})`,
        osType: sql<string>`max(${clientLogs.osType})`,
        osVersion: sql<string>`max(${clientLogs.osVersion})`,
        lastAt: sql<number>`max(${clientLogs.createdAt})`,
        total: sql<number>`count(*)`,
        errors: sql<number>`sum(case when ${clientLogs.level} = 'error' then 1 else 0 end)`
      })
      .from(clientLogs)
      .where(eq(clientLogs.tenant, tenant))
      .groupBy(clientLogs.deviceId)
      .orderBy(desc(sql`max(${clientLogs.createdAt})`))
      .limit(200)
      .all()
  }

  /** 定时清理过期日志 */
  prune(now = Date.now()): number {
    const r = this.db.delete(clientLogs).where(lt(clientLogs.createdAt, now - RETAIN_MS)).run()
    return r.changes
  }
}
