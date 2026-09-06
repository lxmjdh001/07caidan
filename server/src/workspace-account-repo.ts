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

export type WorkspaceAccountUpsertResult =
  | { ok: true; account: WorkspaceAccount; activeAccounts: number }
  | { ok: false; reason: 'account_quota_reached'; activeAccounts: number; accountQuota: number }

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

  /**
   * 在同一数据库事务内检查并写入账号，避免两台电脑同时新增时绕过端口上限。
   * accountQuota = 0 表示不限；更新已有账号不占用新的端口。
   */
  upsertWithinQuota(
    tenant: string,
    input: Omit<WorkspaceAccount, 'deleted' | 'updatedAt'>,
    accountQuota: number
  ): WorkspaceAccountUpsertResult {
    const now = Date.now()
    return this.db.transaction((tx) => {
      const current = tx.select({ deleted: workspaceAccounts.deleted })
        .from(workspaceAccounts)
        .where(and(eq(workspaceAccounts.tenant, tenant), eq(workspaceAccounts.accountKey, input.accountKey)))
        .get()
      const activeAccounts = tx.select({ accountKey: workspaceAccounts.accountKey })
        .from(workspaceAccounts)
        .where(and(eq(workspaceAccounts.tenant, tenant), eq(workspaceAccounts.deleted, 0)))
        .all().length
      const addsPort = !current || current.deleted === 1
      if (accountQuota > 0 && addsPort && activeAccounts >= accountQuota) {
        return { ok: false as const, reason: 'account_quota_reached' as const, activeAccounts, accountQuota }
      }

      tx.insert(workspaceAccounts).values({
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
      return {
        ok: true as const,
        account: { ...input, deleted: false, updatedAt: now },
        activeAccounts: activeAccounts + (addsPort ? 1 : 0)
      }
    })
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
