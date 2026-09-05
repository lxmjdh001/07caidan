import { and, eq } from 'drizzle-orm'
import type { Db } from './db.ts'
import { workspaceAccounts } from './schema.ts'

export interface WorkspaceAccount {
  accountKey: string
  channel: string
  accountId: string
  label?: string
  defaultLang?: string
  deleted: boolean
  updatedAt: number
}

/** 仅保存账号目录摘要；平台凭证、代理、指纹和会话从不进入此表。 */
export class WorkspaceAccountRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  list(tenant: string): WorkspaceAccount[] {
    return this.db.select().from(workspaceAccounts)
      .where(eq(workspaceAccounts.tenant, tenant)).all().map((row) => ({
        accountKey: row.accountKey,
        channel: row.channel,
        accountId: row.accountId,
        label: row.label ?? undefined,
        defaultLang: row.defaultLang ?? undefined,
        deleted: row.deleted === 1,
        updatedAt: row.updatedAt
      }))
  }

  upsert(tenant: string, input: Omit<WorkspaceAccount, 'deleted' | 'updatedAt'>): WorkspaceAccount {
    const now = Date.now()
    this.db.insert(workspaceAccounts).values({
      tenant,
      accountKey: input.accountKey,
      channel: input.channel,
      accountId: input.accountId,
      label: input.label ?? null,
      defaultLang: input.defaultLang ?? null,
      deleted: 0,
      updatedAt: now
    }).onConflictDoUpdate({
      target: [workspaceAccounts.tenant, workspaceAccounts.accountKey],
      set: {
        channel: input.channel,
        accountId: input.accountId,
        label: input.label ?? null,
        defaultLang: input.defaultLang ?? null,
        deleted: 0,
        updatedAt: now
      }
    }).run()
    return { ...input, deleted: false, updatedAt: now }
  }

  remove(tenant: string, accountKey: string, channel: string, accountId: string): WorkspaceAccount {
    const now = Date.now()
    this.db.insert(workspaceAccounts).values({
      tenant, accountKey, channel, accountId, deleted: 1, updatedAt: now
    }).onConflictDoUpdate({
      target: [workspaceAccounts.tenant, workspaceAccounts.accountKey],
      set: { deleted: 1, updatedAt: now }
    }).run()
    return { accountKey, channel, accountId, deleted: true, updatedAt: now }
  }
}
