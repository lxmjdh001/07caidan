import { and, eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import type { Db } from './db.ts'
import { accountEnvironments } from './schema.ts'
import { SecretBox } from './security/secret-box.ts'

export interface AccountEnvironmentView {
  accountKey: string
  snapshot: Record<string, unknown>
  revision: number
  activeDeviceId?: string
  leaseId?: string
  leaseExpiresAt?: number
  updatedAt: number
}

export interface EnvironmentLeaseResult {
  ok: boolean
  environment?: AccountEnvironmentView
  activeDeviceId?: string
  leaseId?: string
  leaseExpiresAt?: number
}

/**
 * 指纹浏览器式账号环境主库：快照加密落库，租约保证同一平台会话只有一个客户端直连。
 */
export class AccountEnvironmentRepo {
  private readonly box: SecretBox
  private readonly db: Db

  constructor(db: Db, encryptionKey: string | undefined) {
    this.db = db
    this.box = new SecretBox(encryptionKey)
  }

  get available(): boolean {
    return this.box.available
  }

  get(tenant: string, accountKey: string): AccountEnvironmentView | null {
    const row = this.db.select().from(accountEnvironments).where(and(
      eq(accountEnvironments.tenant, tenant),
      eq(accountEnvironments.accountKey, accountKey)
    )).get()
    return row ? this.view(row) : null
  }

  acquire(
    tenant: string,
    accountKey: string,
    deviceId: string,
    ttlMs: number,
    takeover: boolean
  ): EnvironmentLeaseResult {
    const current = this.get(tenant, accountKey)
    const now = Date.now()
    if (
      current?.activeDeviceId && current.activeDeviceId !== deviceId &&
      (current.leaseExpiresAt ?? 0) > now && !takeover
    ) {
      return {
        ok: false,
        activeDeviceId: current.activeDeviceId,
        leaseExpiresAt: current.leaseExpiresAt
      }
    }
    const leaseId = randomBytes(16).toString('hex')
    const leaseExpiresAt = now + ttlMs
    if (current) {
      this.db.update(accountEnvironments).set({
        activeDeviceId: deviceId,
        leaseId,
        leaseExpiresAt
      }).where(and(
        eq(accountEnvironments.tenant, tenant),
        eq(accountEnvironments.accountKey, accountKey)
      )).run()
    } else {
      this.db.insert(accountEnvironments).values({
        tenant,
        accountKey,
        snapshot: this.box.seal('{}'),
        revision: 0,
        activeDeviceId: deviceId,
        leaseId,
        leaseExpiresAt,
        updatedAt: now
      }).onConflictDoNothing().run()
      const created = this.get(tenant, accountKey)
      if (created?.activeDeviceId !== deviceId) {
        if (takeover && created) {
          this.db.update(accountEnvironments).set({ activeDeviceId: deviceId, leaseId, leaseExpiresAt }).where(and(
            eq(accountEnvironments.tenant, tenant),
            eq(accountEnvironments.accountKey, accountKey)
          )).run()
          return {
            ok: true,
            environment: { ...created, activeDeviceId: deviceId, leaseId, leaseExpiresAt },
            activeDeviceId: deviceId,
            leaseId,
            leaseExpiresAt
          }
        }
        return {
          ok: false,
          activeDeviceId: created?.activeDeviceId,
          leaseExpiresAt: created?.leaseExpiresAt
        }
      }
    }
    return {
      ok: true,
      environment: current ? { ...current, activeDeviceId: deviceId, leaseId, leaseExpiresAt } : undefined,
      activeDeviceId: deviceId,
      leaseId,
      leaseExpiresAt
    }
  }

  heartbeat(tenant: string, accountKey: string, deviceId: string, leaseId: string, ttlMs: number): boolean {
    const now = Date.now()
    return this.db.update(accountEnvironments).set({ leaseExpiresAt: now + ttlMs }).where(and(
      eq(accountEnvironments.tenant, tenant),
      eq(accountEnvironments.accountKey, accountKey),
      eq(accountEnvironments.activeDeviceId, deviceId),
      eq(accountEnvironments.leaseId, leaseId)
    )).run().changes > 0
  }

  release(tenant: string, accountKey: string, deviceId: string, leaseId: string): boolean {
    return this.db.update(accountEnvironments).set({
      activeDeviceId: null,
      leaseId: null,
      leaseExpiresAt: null
    }).where(and(
      eq(accountEnvironments.tenant, tenant),
      eq(accountEnvironments.accountKey, accountKey),
      eq(accountEnvironments.activeDeviceId, deviceId),
      eq(accountEnvironments.leaseId, leaseId)
    )).run().changes > 0
  }

  put(
    tenant: string,
    accountKey: string,
    deviceId: string,
    leaseId: string,
    snapshot: Record<string, unknown>,
    ttlMs: number
  ): AccountEnvironmentView | null {
    const current = this.get(tenant, accountKey)
    const now = Date.now()
    if (
      !current || current.activeDeviceId !== deviceId || current.leaseId !== leaseId ||
      (current.leaseExpiresAt ?? 0) <= now
    ) {
      return null
    }
    const revision = (current?.revision ?? 0) + 1
    const leaseExpiresAt = now + ttlMs
    const sealed = this.box.seal(JSON.stringify(snapshot))
    this.db.insert(accountEnvironments).values({
      tenant,
      accountKey,
      snapshot: sealed,
      revision,
      activeDeviceId: deviceId,
      leaseId,
      leaseExpiresAt,
      updatedAt: now
    }).onConflictDoUpdate({
      target: [accountEnvironments.tenant, accountEnvironments.accountKey],
      set: { snapshot: sealed, revision, activeDeviceId: deviceId, leaseId, leaseExpiresAt, updatedAt: now }
    }).run()
    return {
      accountKey,
      snapshot,
      revision,
      activeDeviceId: deviceId,
      leaseId,
      leaseExpiresAt,
      updatedAt: now
    }
  }

  remove(tenant: string, accountKey: string): boolean {
    return this.db.delete(accountEnvironments).where(and(
      eq(accountEnvironments.tenant, tenant),
      eq(accountEnvironments.accountKey, accountKey)
    )).run().changes > 0
  }

  private view(row: typeof accountEnvironments.$inferSelect): AccountEnvironmentView {
    const parsed = JSON.parse(this.box.open(row.snapshot)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('账号环境快照格式无效')
    }
    return {
      accountKey: row.accountKey,
      snapshot: parsed as Record<string, unknown>,
      revision: row.revision,
      activeDeviceId: row.activeDeviceId ?? undefined,
      leaseId: row.leaseId ?? undefined,
      leaseExpiresAt: row.leaseExpiresAt ?? undefined,
      updatedAt: row.updatedAt
    }
  }
}
