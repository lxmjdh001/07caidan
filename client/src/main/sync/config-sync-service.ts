import type { AppSettings } from '@shared/settings'
import type { SettingsStore } from '../core/settings-store'
import { noopLogger, type Logger } from '../core/logger'
import { applySyncable, pickSyncable } from './config-sync'

const clean = (u: string): string => u.trim().replace(/\/$/, '')

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

  constructor(
    settings: SettingsStore,
    opts: { logger?: Logger; onApplied?: (s: AppSettings) => void } = {}
  ) {
    this.settings = settings
    this.log = (opts.logger ?? noopLogger).child('config-sync')
    this.onApplied = opts.onApplied
  }

  private active(): { serverUrl: string; token: string } | null {
    const sync = this.settings.get().sync
    if (sync.cloudSync === false) return null
    if (!sync.token || !sync.serverUrl) return null
    return { serverUrl: clean(sync.serverUrl), token: sync.token }
  }

  /** 拉云端偏好；仅当云端版本更新时才覆盖本地 */
  async pull(): Promise<void> {
    const a = this.active()
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

  /** 本地偏好变更后调用；1.5s 防抖合并多次改动 */
  pushDebounced(): void {
    if (!this.active()) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.push(), 1500)
  }

  async push(): Promise<void> {
    const a = this.active()
    if (!a) return
    const blob = pickSyncable(this.settings.get())
    const updatedAt = Date.now()
    try {
      const res = await fetch(`${a.serverUrl}/api/client/settings`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ blob, updatedAt }),
        signal: AbortSignal.timeout(15_000)
      })
      if (!res.ok) return
      const saved = (await res.json()) as { updatedAt?: number }
      await this.settings.update({
        sync: { ...this.settings.get().sync, settingsSyncedAt: saved.updatedAt ?? updatedAt }
      })
      this.log.debug('本地偏好已上云', { updatedAt })
    } catch (err) {
      this.log.debug('云端偏好上传失败', { err: String(err) })
    }
  }
}
