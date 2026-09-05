import type { AppSettings } from '@shared/settings'
import type { SettingsStore } from '../core/settings-store'
import { noopLogger, type Logger } from '../core/logger'
import { createAccountFingerprint } from '../core/account-fingerprint'
import { applySyncable, pickSyncable, pickSyncableAccounts, type SyncableAccount } from './config-sync'

const clean = (u: string): string => u.trim().replace(/\/$/, '')
const ACCOUNT_POLL_MS = 10_000

interface RemoteAccount extends SyncableAccount {
  deleted?: boolean
  updatedAt?: number
}

/**
 * 配置云同步服务（主进程）。
 * 登录/启动时 pull 云端偏好并合并到本地；本地偏好变更时 pushDebounced 上云。
 * 只搬运 pickSyncable 的白名单（无凭证）。冲突后写为准（updatedAt 比较）。
 */
export class ConfigSync {
  private readonly settings: SettingsStore
  private readonly log: Logger
  private readonly onApplied?: (s: AppSettings) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private pendingPush: Promise<void> = Promise.resolve()
  private accountSnapshot = new Map<string, string>()

  constructor(
    settings: SettingsStore,
    opts: { logger?: Logger; onApplied?: (s: AppSettings) => void } = {}
  ) {
    this.settings = settings
    this.log = (opts.logger ?? noopLogger).child('config-sync')
    this.onApplied = opts.onApplied
    this.accountSnapshot = accountMap(pickSyncableAccounts(this.settings.get()))
  }

  /** 登录主库后的基础跨设备通道。账号目录属于业务数据，不能被“偏好漫游”开关关闭。 */
  private authenticated(): { serverUrl: string; token: string } | null {
    const sync = this.settings.get().sync
    if (!sync.token || !sync.serverUrl) return null
    return { serverUrl: clean(sync.serverUrl), token: sync.token }
  }

  /** 用户可关闭的仅是界面/翻译等个人偏好；消息与账号目录仍必须进入主库。 */
  private preferencesActive(): { serverUrl: string; token: string } | null {
    if (this.settings.get().sync.cloudSync === false) return null
    return this.authenticated()
  }

  /** 拉云端偏好；仅当云端版本更新时才覆盖本地 */
  async pull(): Promise<void> {
    await this.pullPreferences()
    await this.pullAccounts()
  }

  /** 每 10 秒检查一次另一台电脑的账号目录与偏好变更。 */
  start(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => void this.pull(), ACCOUNT_POLL_MS)
  }

  private async pullPreferences(): Promise<void> {
    const a = this.preferencesActive()
    if (!a) return
    try {
      const res = await fetch(`${a.serverUrl}/api/client/settings`, {
        headers: { authorization: `Bearer ${a.token}` },
        signal: AbortSignal.timeout(15_000)
      })
      if (!res.ok) return
      const remote = (await res.json()) as { blob?: unknown; updatedAt?: number }
      if (typeof remote.updatedAt !== 'number' || remote.updatedAt <= 0) return
      const localSyncedAt = this.settings.get().sync.settingsSyncedAt ?? 0
      if (remote.updatedAt <= localSyncedAt) return // 本地已是最新或更新
      const patch = applySyncable(this.settings.get(), remote.blob)
      const updated = await this.settings.update({
        ...patch,
        sync: { ...this.settings.get().sync, settingsSyncedAt: remote.updatedAt }
      })
      this.log.info('已从云端拉取偏好并合并', { updatedAt: remote.updatedAt })
      this.onApplied?.(updated)
    } catch (err) {
      this.log.debug('云端偏好拉取失败', { err: String(err) })
    }
  }

  private async pullAccounts(): Promise<void> {
    const a = this.authenticated()
    if (!a) return
    try {
      const res = await fetch(`${a.serverUrl}/api/client/accounts`, {
        headers: { authorization: `Bearer ${a.token}` },
        signal: AbortSignal.timeout(15_000)
      })
      if (!res.ok) return
      const data = (await res.json()) as { accounts?: RemoteAccount[] }
      if (!Array.isArray(data.accounts)) return

      const current = this.settings.get().accounts
      const next = structuredClone(current)
      const previousSnapshot = this.accountSnapshot
      const serverSnapshot = new Map<string, string>()
      let changed = false
      for (const remote of data.accounts) {
        if (!validRemoteAccount(remote)) continue
        if (remote.deleted) {
          if (next[remote.accountKey]) {
            delete next[remote.accountKey]
            changed = true
          }
          continue
        }
        const safe = accountSafeJson(remote)
        serverSnapshot.set(remote.accountKey, safe)
        const existing = next[remote.accountKey]
        if (!existing) {
          next[remote.accountKey] = {
            fingerprint: createAccountFingerprint(remote.accountKey),
            label: remote.label,
            defaultLang: remote.defaultLang
          }
          changed = true
        } else {
          const localAccount = pickSyncableAccounts({
            ...this.settings.get(),
            accounts: { [remote.accountKey]: existing }
          })[0] ?? remote
          const localSafe = accountSafeJson(localAccount)
          const hasPendingLocalEdit = previousSnapshot.get(remote.accountKey) !== localSafe
          if (localSafe === safe || hasPendingLocalEdit) continue
          // 本机安全字段完整保留，只应用可漫游的备注和客户语言。
          next[remote.accountKey] = {
            ...existing,
            label: remote.label,
            defaultLang: remote.defaultLang
          }
          changed = true
        }
      }
      this.accountSnapshot = serverSnapshot
      if (changed) {
        const updated = await this.settings.replaceAccounts(next)
        this.onApplied?.(updated)
      }
      // 本机离线期间创建、而云端尚无记录的账号，在拉取完成后逐条补上云。
      await this.pushAccountChanges(a)
    } catch (err) {
      this.log.debug('云端账号目录拉取失败', { err: String(err) })
    }
  }

  /** 本地偏好变更后调用；1.5s 防抖合并多次改动 */
  pushDebounced(): void {
    if (!this.authenticated()) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.enqueuePush()
    }, 1500)
  }

  /** 等待已触发的上传完成；有尚未到点的防抖任务时立即执行。用于测试与安全退出。 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
      await this.enqueuePush()
      return
    }
    await this.pendingPush
  }

  /** 取消尚未开始的防抖任务。 */
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  private enqueuePush(): Promise<void> {
    const next = this.pendingPush.then(() => this.push())
    this.pendingPush = next.catch(() => undefined)
    return next
  }

  async push(): Promise<void> {
    const a = this.authenticated()
    if (!a) return
    try {
      if (this.preferencesActive()) {
        const blob = pickSyncable(this.settings.get())
        const updatedAt = Date.now()
        const res = await fetch(`${a.serverUrl}/api/client/settings`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ blob, updatedAt }),
          signal: AbortSignal.timeout(15_000)
        })
        if (res.ok) {
          const saved = (await res.json()) as { updatedAt?: number }
          await this.settings.update({
            sync: { ...this.settings.get().sync, settingsSyncedAt: saved.updatedAt ?? updatedAt }
          })
          this.log.debug('本地偏好已上云', { updatedAt })
        }
      }
      await this.pushAccountChanges(a)
    } catch (err) {
      this.log.debug('云端偏好上传失败', { err: String(err) })
    }
  }

  private async pushAccountChanges(a: { serverUrl: string; token: string }): Promise<void> {
    const local = pickSyncableAccounts(this.settings.get())
    const next = accountMap(local)
    for (const account of local) {
      if (this.accountSnapshot.get(account.accountKey) === next.get(account.accountKey)) continue
      const res = await fetch(`${a.serverUrl}/api/client/accounts/${encodeURIComponent(account.accountKey)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(account),
        signal: AbortSignal.timeout(15_000)
      })
      if (res.ok) this.accountSnapshot.set(account.accountKey, next.get(account.accountKey)!)
    }
    for (const key of [...this.accountSnapshot.keys()]) {
      if (next.has(key)) continue
      const res = await fetch(`${a.serverUrl}/api/client/accounts/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${a.token}` },
        signal: AbortSignal.timeout(15_000)
      })
      if (res.ok) this.accountSnapshot.delete(key)
    }
  }
}

function accountSafeJson(account: SyncableAccount): string {
  return JSON.stringify({
    accountKey: account.accountKey,
    channel: account.channel,
    accountId: account.accountId,
    label: account.label,
    defaultLang: account.defaultLang
  })
}

function accountMap(accounts: SyncableAccount[]): Map<string, string> {
  return new Map(accounts.map((account) => [account.accountKey, accountSafeJson(account)]))
}

function validRemoteAccount(value: RemoteAccount): boolean {
  if (!value || typeof value !== 'object') return false
  const separator = value.accountKey?.indexOf(':') ?? -1
  if (separator <= 0) return false
  return value.accountKey.slice(0, separator) === value.channel &&
    value.accountKey.slice(separator + 1) === value.accountId &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(value.accountId)
}
