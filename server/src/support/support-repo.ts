import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { supportMessages, supportTickets } from '../schema.ts'

export type TicketStatus = 'open' | 'replied' | 'closed'

export interface Ticket {
  id: string
  userId: number
  title: string
  status: TicketStatus
  createdAt: number
  updatedAt: number
}

export interface TicketMessage {
  id: number
  sender: 'user' | 'admin'
  senderName?: string
  body: string
  mediaId?: string
  createdAt: number
}

/**
 * 支持工单（软件使用问题）。
 *
 * 状态机刻意简单：open（等管理员）→ replied（等用户）→ closed。
 * 任一方追加消息就把状态拨向对方；closed 后用户仍可追加消息重新打开 ——
 * "问题没解决但工单被关了"是支持系统最招恨的体验。
 */
export class SupportRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  create(
    tenant: string,
    userId: number,
    title: string,
    body: string,
    mediaId?: string,
    now = Date.now()
  ): Ticket {
    const row = {
      tenant,
      id: randomUUID(),
      userId,
      title,
      status: 'open',
      createdAt: now,
      updatedAt: now
    }
    this.db.insert(supportTickets).values(row).run()
    this.db
      .insert(supportMessages)
      .values({
        tenant,
        ticketId: row.id,
        sender: 'user',
        senderName: null,
        body,
        mediaId: mediaId ?? null,
        createdAt: now
      })
      .run()
    return toTicket(row as typeof supportTickets.$inferSelect)
  }

  /** 用户视角：只能看自己的 */
  listForUser(tenant: string, userId: number): Ticket[] {
    return this.db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.tenant, tenant), eq(supportTickets.userId, userId)))
      .orderBy(desc(supportTickets.updatedAt))
      .all()
      .map(toTicket)
  }

  /** 管理员视角：全部；open 的排前面（等着处理的最要紧） */
  listAll(tenant: string): Ticket[] {
    return this.db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.tenant, tenant))
      .orderBy(
        sql`CASE ${supportTickets.status} WHEN 'open' THEN 0 WHEN 'replied' THEN 1 ELSE 2 END`,
        desc(supportTickets.updatedAt)
      )
      .all()
      .map(toTicket)
  }

  get(tenant: string, id: string): Ticket | null {
    const r = this.db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.tenant, tenant), eq(supportTickets.id, id)))
      .get()
    return r ? toTicket(r) : null
  }

  messages(tenant: string, ticketId: string): TicketMessage[] {
    return this.db
      .select()
      .from(supportMessages)
      .where(and(eq(supportMessages.tenant, tenant), eq(supportMessages.ticketId, ticketId)))
      .orderBy(asc(supportMessages.createdAt), asc(supportMessages.id))
      .all()
      .map((r) => ({
        id: r.id,
        sender: r.sender as 'user' | 'admin',
        senderName: r.senderName ?? undefined,
        body: r.body,
        mediaId: r.mediaId ?? undefined,
        createdAt: r.createdAt
      }))
  }

  /** 追加消息。用户发言 → open（重新打开也走这里）；管理员发言 → replied。 */
  addMessage(
    tenant: string,
    ticketId: string,
    sender: 'user' | 'admin',
    body: string,
    opts: { senderName?: string; mediaId?: string; now?: number } = {}
  ): boolean {
    const now = opts.now ?? Date.now()
    const exists = this.get(tenant, ticketId)
    if (!exists) return false
    this.db
      .insert(supportMessages)
      .values({
        tenant,
        ticketId,
        sender,
        senderName: opts.senderName ?? null,
        body,
        mediaId: opts.mediaId ?? null,
        createdAt: now
      })
      .run()
    this.db
      .update(supportTickets)
      .set({ status: sender === 'admin' ? 'replied' : 'open', updatedAt: now })
      .where(and(eq(supportTickets.tenant, tenant), eq(supportTickets.id, ticketId)))
      .run()
    return true
  }

  close(tenant: string, ticketId: string, now = Date.now()): boolean {
    return (
      this.db
        .update(supportTickets)
        .set({ status: 'closed', updatedAt: now })
        .where(and(eq(supportTickets.tenant, tenant), eq(supportTickets.id, ticketId)))
        .run().changes > 0
    )
  }
}

function toTicket(r: typeof supportTickets.$inferSelect): Ticket {
  return {
    id: r.id,
    userId: r.userId,
    title: r.title,
    status: r.status as TicketStatus,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}
