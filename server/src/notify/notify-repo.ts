import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import {
  announcementReads,
  announcements,
  remindersSent,
  reminderSettings,
  userNotices
} from '../schema.ts'
import { DEFAULT_REMINDER_BODY, DEFAULT_REMINDER_SUBJECT } from './template.ts'

export type Audience = 'all' | 'plan' | 'new_users' | 'expiring'

export interface Announcement {
  id: string
  title: string
  body: string
  audience: Audience
  audienceParam: string
  enabled: boolean
  createdAt: number
}

export interface UserNotice {
  id: number
  kind: string
  title: string
  body: string
  createdAt: number
}

export interface ReminderConfig {
  enabled: boolean
  daysBefore: number[]
  emailEnabled: boolean
  emailSubject: string
  emailBody: string
}

/** 受众求值需要的用户画像 */
export interface UserProfile {
  userId: number
  registeredAt: number
  planId?: string
  /** 有效订阅的到期时间 */
  expiresAt?: number
}

const DAY = 86_400_000

/**
 * 公告是否命中该用户。纯函数，受众规则一目了然：
 * - all：所有人
 * - plan：当前订阅了指定套餐
 * - new_users：注册不超过 N 天
 * - expiring：有订阅且 N 天内到期（已过期的不算 —— 那是催回流不是提醒）
 */
export function matchesAudience(a: Announcement, u: UserProfile, now = Date.now()): boolean {
  switch (a.audience) {
    case 'all':
      return true
    case 'plan':
      return !!u.planId && u.planId === a.audienceParam
    case 'new_users': {
      const days = Number(a.audienceParam) || 7
      return now - u.registeredAt <= days * DAY
    }
    case 'expiring': {
      const days = Number(a.audienceParam) || 7
      if (u.expiresAt === undefined) return false
      const left = u.expiresAt - now
      return left > 0 && left <= days * DAY
    }
    default:
      return false
  }
}

/** "7,3,1" → [7,3,1]（去重、正整数、降序） */
export function parseDays(raw: string): number[] {
  const set = new Set<number>()
  for (const part of raw.split(/[,，\s]+/)) {
    const n = Math.floor(Number(part))
    if (Number.isFinite(n) && n > 0 && n <= 365) set.add(n)
  }
  return [...set].sort((a, b) => b - a)
}

export class NotifyRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  // ── 公告 ──

  createAnnouncement(
    tenant: string,
    input: {
      title: string
      body: string
      audience: Audience
      audienceParam?: string
      enabled?: boolean
    }
  ): Announcement {
    const row = {
      tenant,
      id: randomUUID(),
      title: input.title,
      body: input.body,
      audience: input.audience,
      audienceParam: input.audienceParam ?? '',
      enabled: input.enabled === false ? 0 : 1,
      createdAt: Date.now()
    }
    this.db.insert(announcements).values(row).run()
    return toAnnouncement(row as typeof announcements.$inferSelect)
  }

  listAnnouncements(tenant: string): Announcement[] {
    return this.db
      .select()
      .from(announcements)
      .where(eq(announcements.tenant, tenant))
      .orderBy(desc(announcements.createdAt))
      .all()
      .map(toAnnouncement)
  }

  updateAnnouncement(
    tenant: string,
    id: string,
    patch: Partial<{
      title: string
      body: string
      audience: Audience
      audienceParam: string
      enabled: boolean
    }>
  ): boolean {
    const set: Record<string, unknown> = {}
    if (patch.title !== undefined) set.title = patch.title
    if (patch.body !== undefined) set.body = patch.body
    if (patch.audience !== undefined) set.audience = patch.audience
    if (patch.audienceParam !== undefined) set.audienceParam = patch.audienceParam
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
    if (Object.keys(set).length === 0) return true
    return (
      this.db
        .update(announcements)
        .set(set)
        .where(and(eq(announcements.tenant, tenant), eq(announcements.id, id)))
        .run().changes > 0
    )
  }

  deleteAnnouncement(tenant: string, id: string): boolean {
    this.db
      .delete(announcementReads)
      .where(and(eq(announcementReads.tenant, tenant), eq(announcementReads.announcementId, id)))
      .run()
    return (
      this.db
        .delete(announcements)
        .where(and(eq(announcements.tenant, tenant), eq(announcements.id, id)))
        .run().changes > 0
    )
  }

  /** 该用户当前应看到且未读的公告 */
  unreadAnnouncementsFor(tenant: string, profile: UserProfile, now = Date.now()): Announcement[] {
    const read = new Set(
      this.db
        .select({ id: announcementReads.announcementId })
        .from(announcementReads)
        .where(
          and(eq(announcementReads.tenant, tenant), eq(announcementReads.userId, profile.userId))
        )
        .all()
        .map((r) => r.id)
    )
    return this.listAnnouncements(tenant).filter(
      (a) => a.enabled && !read.has(a.id) && matchesAudience(a, profile, now)
    )
  }

  markAnnouncementsRead(tenant: string, userId: number, ids: string[], now = Date.now()): void {
    for (const id of ids) {
      this.db
        .insert(announcementReads)
        .values({ tenant, announcementId: id, userId, readAt: now })
        .onConflictDoNothing()
        .run()
    }
  }

  // ── 个人通知 ──

  addNotice(
    tenant: string,
    userId: number,
    kind: string,
    title: string,
    body: string,
    now = Date.now()
  ): number {
    const res = this.db
      .insert(userNotices)
      .values({ tenant, userId, kind, title, body, readAt: null, createdAt: now })
      .run()
    return Number(res.lastInsertRowid)
  }

  unreadNotices(tenant: string, userId: number): UserNotice[] {
    return this.db
      .select()
      .from(userNotices)
      .where(
        and(
          eq(userNotices.tenant, tenant),
          eq(userNotices.userId, userId),
          isNull(userNotices.readAt)
        )
      )
      .orderBy(desc(userNotices.createdAt))
      .all()
      .map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, createdAt: r.createdAt }))
  }

  markNoticesRead(tenant: string, userId: number, ids: number[], now = Date.now()): void {
    if (ids.length === 0) return
    this.db
      .update(userNotices)
      .set({ readAt: now })
      .where(
        and(
          eq(userNotices.tenant, tenant),
          eq(userNotices.userId, userId),
          sql`${userNotices.id} IN (${sql.join(
            ids.map((i) => sql`${i}`),
            sql`, `
          )})`
        )
      )
      .run()
  }

  // ── 到期提醒配置与去重 ──

  reminderConfig(tenant: string): ReminderConfig {
    const r = this.db
      .select()
      .from(reminderSettings)
      .where(eq(reminderSettings.tenant, tenant))
      .get()
    return {
      enabled: (r?.enabled ?? 0) === 1,
      daysBefore: parseDays(r?.daysBefore ?? '7,3,1'),
      emailEnabled: (r?.emailEnabled ?? 0) === 1,
      emailSubject: r?.emailSubject || DEFAULT_REMINDER_SUBJECT,
      emailBody: r?.emailBody || DEFAULT_REMINDER_BODY
    }
  }

  updateReminderConfig(tenant: string, patch: Partial<ReminderConfig>): ReminderConfig {
    const cur = this.reminderConfig(tenant)
    const next: ReminderConfig = {
      enabled: patch.enabled ?? cur.enabled,
      daysBefore: patch.daysBefore?.length ? parseDays(patch.daysBefore.join(',')) : cur.daysBefore,
      emailEnabled: patch.emailEnabled ?? cur.emailEnabled,
      emailSubject: patch.emailSubject ?? cur.emailSubject,
      emailBody: patch.emailBody ?? cur.emailBody
    }
    this.db
      .insert(reminderSettings)
      .values({
        tenant,
        enabled: next.enabled ? 1 : 0,
        daysBefore: next.daysBefore.join(','),
        emailEnabled: next.emailEnabled ? 1 : 0,
        emailSubject: next.emailSubject,
        emailBody: next.emailBody,
        updatedAt: Date.now()
      })
      .onConflictDoUpdate({
        target: reminderSettings.tenant,
        set: {
          enabled: sql`excluded.enabled`,
          daysBefore: sql`excluded.days_before`,
          emailEnabled: sql`excluded.email_enabled`,
          emailSubject: sql`excluded.email_subject`,
          emailBody: sql`excluded.email_body`,
          updatedAt: sql`excluded.updated_at`
        }
      })
      .run()
    return next
  }

  /** 尝试记录一次提醒；已发过返回 false（幂等的关键） */
  tryMarkReminderSent(
    tenant: string,
    userId: number,
    threshold: number,
    expiresAt: number,
    now = Date.now()
  ): boolean {
    const res = this.db
      .insert(remindersSent)
      .values({ tenant, userId, threshold, expiresAt, sentAt: now })
      .onConflictDoNothing()
      .run()
    return res.changes > 0
  }
}

function toAnnouncement(r: typeof announcements.$inferSelect): Announcement {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    audience: r.audience as Audience,
    audienceParam: r.audienceParam,
    enabled: r.enabled === 1,
    createdAt: r.createdAt
  }
}
