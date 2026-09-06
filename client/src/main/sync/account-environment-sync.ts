import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { AccountConfig, AppSettings, ProxyAsset } from '@shared/settings'
import type { SettingsStore } from '../core/settings-store'
import { deviceId } from '../core/device-id'
import { noopLogger, type Logger } from '../core/logger'

interface EnvironmentFile {
  path: string
  data: string
}

interface AccountEnvironmentSnapshot {
  version: 1
  account: AccountConfig
  proxyAsset?: ProxyAsset
  files: EnvironmentFile[]
}

interface RemoteEnvironment {
  accountKey: string
  snapshot: Record<string, unknown>
  revision: number
  updatedAt: number
}

interface RevisionState {
  revisions: Record<string, number>
}

const HEARTBEAT_MS = 20_000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 36 * 1024 * 1024
const ACCOUNT_KEY = /^[a-z_]+:[a-zA-Z0-9_-]{1,128}$/

/**
 * 指纹浏览器式账号环境漫游：代理、稳定指纹、平台登录态与会话文件跟随 WzzScrm
 * 工作区；服务器只保存 AES-GCM 密文。同一环境通过租约只允许一台电脑连接平台。
 */
export class AccountEnvironmentSync {
  private readonly log: Logger
  private readonly revisionsPath: string
  private revisions: Record<string, number> = {}
  private readonly accountHashes = new Map<string, string>()
  private readonly leases = new Map<string, string>()
  private readonly uploadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private initialized = false

  constructor(
    private readonly settings: SettingsStore,
    private readonly userData: string,
    private readonly onLeaseLost: (accountKey: string, detail: string) => void,
    logger?: Logger
  ) {
    this.log = (logger ?? noopLogger).child('account-environment-sync')
    this.revisionsPath = join(userData, 'data', 'environment-sync-state.json')
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      const parsed = JSON.parse(await readFile(this.revisionsPath, 'utf8')) as RevisionState
      if (parsed?.revisions && typeof parsed.revisions === 'object') this.revisions = parsed.revisions
    } catch {
      this.revisions = {}
    }
    this.rememberSettings(this.settings.get())
  }

  /** 启动平台连接前获取租约；显式启动即视为从另一台电脑安全接管。 */
  async acquire(accountKey: string): Promise<void> {
    await this.init()
    if (this.leases.has(accountKey)) return
    const cfg = this.backend()
    if (!cfg) return
    const result = await this.post(
      cfg,
      `/api/client/environments/${encodeURIComponent(accountKey)}/lease`,
      { deviceId: deviceId(), takeover: true }
    ) as { environment?: RemoteEnvironment; leaseId?: unknown }
    if (typeof result.leaseId !== 'string' || !/^[a-f0-9]{32}$/i.test(result.leaseId)) {
      throw new Error('服务器未返回有效账号环境租约')
    }
    const remote = result.environment
    if (remote && remote.revision > 0 && validRemoteEnvironment(remote)) {
      await this.restore(accountKey, remote.snapshot)
      this.revisions[accountKey] = remote.revision
      await this.persistRevisions()
    }
    this.leases.set(accountKey, result.leaseId)
    this.startHeartbeat()
    // 升级前已有本地登录态、服务器尚无快照：取得租约后立即完成首次迁移。
    if (!remote || remote.revision === 0) await this.upload(accountKey)
  }

  isUsable(accountKey: string): boolean {
    return !this.backend() || this.leases.has(accountKey)
  }

  scheduleUpload(accountKey: string): void {
    if (!ACCOUNT_KEY.test(accountKey) || !this.backend()) return
    this.rememberAccount(accountKey)
    const previous = this.uploadTimers.get(accountKey)
    if (previous) clearTimeout(previous)
    this.uploadTimers.set(accountKey, setTimeout(() => {
      this.uploadTimers.delete(accountKey)
      void this.upload(accountKey).catch((error) => {
        this.log.warn('上传账号环境失败，将在下次变更重试', { accountKey, error: String(error) })
      })
    }, 500))
  }

  scheduleAll(settings: AppSettings = this.settings.get()): void {
    const current = new Set(Object.keys(settings.accounts))
    for (const key of current) {
      const hash = environmentSettingsHash(settings, key)
      if (this.accountHashes.get(key) === hash) continue
      this.accountHashes.set(key, hash)
      this.scheduleUpload(key)
    }
    for (const key of this.accountHashes.keys()) {
      if (!current.has(key)) this.accountHashes.delete(key)
    }
  }

  async upload(accountKey: string): Promise<void> {
    const cfg = this.backend()
    if (!cfg || !ACCOUNT_KEY.test(accountKey)) return
    const temporaryLease = !this.leases.has(accountKey)
    if (temporaryLease) {
      const leased = await this.post(
        cfg,
        `/api/client/environments/${encodeURIComponent(accountKey)}/lease`,
        { deviceId: deviceId(), takeover: false }
      ) as { leaseId?: unknown }
      if (typeof leased.leaseId !== 'string' || !/^[a-f0-9]{32}$/i.test(leased.leaseId)) {
        throw new Error('服务器未返回有效账号环境租约')
      }
      this.leases.set(accountKey, leased.leaseId)
      this.startHeartbeat()
    }
    try {
      const leaseId = this.leases.get(accountKey)
      if (!leaseId) throw new Error('账号环境租约已失效')
      const snapshot = await this.snapshot(accountKey)
      const result = await this.put(
        cfg,
        `/api/client/environments/${encodeURIComponent(accountKey)}`,
        { deviceId: deviceId(), leaseId, snapshot }
      ) as { environment?: RemoteEnvironment }
      if (result.environment?.revision) {
        this.revisions[accountKey] = result.environment.revision
        await this.persistRevisions()
      }
    } finally {
      if (temporaryLease) await this.release(accountKey)
    }
  }

  async release(accountKey: string): Promise<void> {
    const cfg = this.backend()
    const leaseId = this.leases.get(accountKey)
    this.leases.delete(accountKey)
    this.stopHeartbeatWhenIdle()
    if (!cfg || !leaseId) return
    await this.post(
      cfg,
      `/api/client/environments/${encodeURIComponent(accountKey)}/release`,
      { deviceId: deviceId(), leaseId }
    ).catch(() => undefined)
  }

  async remove(accountKey: string): Promise<void> {
    const cfg = this.backend()
    const pending = this.uploadTimers.get(accountKey)
    if (pending) clearTimeout(pending)
    this.uploadTimers.delete(accountKey)
    this.leases.delete(accountKey)
    this.accountHashes.delete(accountKey)
    this.stopHeartbeatWhenIdle()
    delete this.revisions[accountKey]
    await this.persistRevisions()
    if (!cfg) return
    await fetch(`${cfg.url}/api/client/environments/${encodeURIComponent(accountKey)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(10_000)
    }).catch(() => undefined)
  }

  async stop(): Promise<void> {
    for (const timer of this.uploadTimers.values()) clearTimeout(timer)
    this.uploadTimers.clear()
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    await Promise.allSettled([...this.leases.keys()].map((key) => this.release(key)))
  }

  private async snapshot(accountKey: string): Promise<AccountEnvironmentSnapshot> {
    const account = this.settings.accountConfig(accountKey)
    const proxyAsset = account.proxyId
      ? this.settings.get().proxyAssets[account.proxyId]
      : undefined
    return {
      version: 1,
      account,
      proxyAsset,
      files: await this.readEnvironmentFiles(accountKey)
    }
  }

  private async restore(accountKey: string, value: Record<string, unknown>): Promise<void> {
    if (value.version !== 1 || !value.account || typeof value.account !== 'object') return
    const snapshot = value as unknown as AccountEnvironmentSnapshot
    const current = this.settings.get()
    const accounts = structuredClone(current.accounts)
    const proxyAssets = structuredClone(current.proxyAssets)
    accounts[accountKey] = {
      ...(accounts[accountKey] ?? {}),
      ...structuredClone(snapshot.account)
    }
    if (snapshot.proxyAsset?.id && snapshot.proxyAsset.proxyUrl) {
      proxyAssets[snapshot.proxyAsset.id] = structuredClone(snapshot.proxyAsset)
    }
    await this.writeEnvironmentFiles(accountKey, Array.isArray(snapshot.files) ? snapshot.files : [])
    await this.settings.replaceNetworkConfig(accounts, proxyAssets)
    this.rememberAccount(accountKey)
    this.log.info('已恢复账号独立环境', { accountKey })
  }

  private environmentRoots(accountKey: string): Array<{ disk: string; archive: string; directory: boolean }> {
    const separator = accountKey.indexOf(':')
    const channel = accountKey.slice(0, separator)
    const accountId = accountKey.slice(separator + 1)
    if (channel === 'whatsapp') {
      return [{
        disk: join(this.userData, 'channels', 'whatsapp', 'auth', accountId),
        archive: 'whatsapp-auth',
        directory: true
      }]
    }
    if (channel === 'line') {
      return [{
        disk: join(this.userData, 'channels', 'line', 'sessions', `${accountId}.json`),
        archive: 'line-session.json',
        directory: false
      }]
    }
    return []
  }

  private async readEnvironmentFiles(accountKey: string): Promise<EnvironmentFile[]> {
    const files: EnvironmentFile[] = []
    let total = 0
    for (const root of this.environmentRoots(accountKey)) {
      const info = await stat(root.disk).catch(() => undefined)
      if (!info) continue
      const candidates = info.isDirectory() ? await walkFiles(root.disk) : [root.disk]
      for (const path of candidates) {
        const fileInfo = await stat(path)
        if (!fileInfo.isFile() || fileInfo.size > MAX_FILE_BYTES) continue
        total += fileInfo.size
        if (total > MAX_TOTAL_BYTES) throw new Error('本地账号环境超过 36MB 上限')
        const suffix = info.isDirectory() ? relative(root.disk, path).split(sep).join('/') : ''
        files.push({
          path: suffix ? `${root.archive}/${suffix}` : root.archive,
          data: (await readFile(path)).toString('base64')
        })
      }
    }
    return files
  }

  private async writeEnvironmentFiles(accountKey: string, files: EnvironmentFile[]): Promise<void> {
    const environmentRoots = this.environmentRoots(accountKey)
    const roots = new Map(environmentRoots.map((item) => [item.archive, item]))
    const decoded: Array<{ target: string; data: Buffer }> = []
    let total = 0
    for (const file of files) {
      if (!file || typeof file.path !== 'string' || typeof file.data !== 'string') continue
      const [archive, ...parts] = file.path.split('/')
      const root = roots.get(archive ?? '')
      if (!root || parts.some((part) => !part || part === '.' || part === '..')) continue
      if ((root.directory && parts.length === 0) || (!root.directory && parts.length > 0)) continue
      const target = parts.length > 0 ? join(root.disk, ...parts) : root.disk
      if (!insideAllowedRoot(target, root.disk, !root.directory)) continue
      const data = Buffer.from(file.data, 'base64')
      total += data.length
      if (data.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new Error('云端账号环境文件过大')
      decoded.push({ target, data })
    }
    // 云端是当前工作区的权威环境；先清掉同名旧设备残留，避免 Signal/E2EE 密钥串号。
    for (const root of environmentRoots) {
      await rm(root.disk, { recursive: root.directory, force: true })
    }
    for (const file of decoded) {
      const { target, data } = file
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, data, { mode: 0o600 })
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS)
  }

  private async heartbeat(): Promise<void> {
    const cfg = this.backend()
    if (!cfg) return
    for (const [accountKey, leaseId] of [...this.leases]) {
      try {
        await this.post(
          cfg,
          `/api/client/environments/${encodeURIComponent(accountKey)}/heartbeat`,
          { deviceId: deviceId(), leaseId }
        )
      } catch (error) {
        this.leases.delete(accountKey)
        this.stopHeartbeatWhenIdle()
        this.onLeaseLost(accountKey, '账号环境已在另一台电脑接管')
        this.log.warn('账号环境租约丢失，已停止本机连接', { accountKey, error: String(error) })
      }
    }
  }

  private backend(): { url: string; token: string } | null {
    const sync = this.settings.get().sync
    if (!sync.serverUrl || !sync.token) return null
    return { url: sync.serverUrl.replace(/\/$/, ''), token: sync.token }
  }

  private stopHeartbeatWhenIdle(): void {
    if (this.leases.size > 0 || !this.heartbeatTimer) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private rememberSettings(settings: AppSettings): void {
    this.accountHashes.clear()
    for (const key of Object.keys(settings.accounts)) {
      this.accountHashes.set(key, environmentSettingsHash(settings, key))
    }
  }

  private rememberAccount(accountKey: string): void {
    const settings = this.settings.get()
    if (settings.accounts[accountKey]) {
      this.accountHashes.set(accountKey, environmentSettingsHash(settings, accountKey))
    }
  }

  private async post(
    cfg: { url: string; token: string },
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(cfg, path, 'POST', body)
  }

  private async put(
    cfg: { url: string; token: string },
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.request(cfg, path, 'PUT', body)
  }

  private async request(
    cfg: { url: string; token: string },
    path: string,
    method: 'POST' | 'PUT',
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${cfg.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`)
    return data
  }

  private async persistRevisions(): Promise<void> {
    await mkdir(dirname(this.revisionsPath), { recursive: true, mode: 0o700 })
    await writeFile(
      this.revisionsPath,
      JSON.stringify({ revisions: this.revisions }),
      { encoding: 'utf8', mode: 0o600 }
    )
  }
}

function validRemoteEnvironment(value: unknown): value is RemoteEnvironment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const environment = value as Partial<RemoteEnvironment>
  return typeof environment.accountKey === 'string' && ACCOUNT_KEY.test(environment.accountKey) &&
    typeof environment.revision === 'number' && Number.isSafeInteger(environment.revision) &&
    !!environment.snapshot && typeof environment.snapshot === 'object' && !Array.isArray(environment.snapshot)
}

function environmentSettingsHash(settings: AppSettings, accountKey: string): string {
  const account = settings.accounts[accountKey]
  const proxyAsset = account?.proxyId ? settings.proxyAssets[account.proxyId] : undefined
  return JSON.stringify({ account, proxyAsset })
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await walkFiles(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

function insideAllowedRoot(target: string, root: string, rootIsFile: boolean): boolean {
  const resolvedTarget = resolve(target)
  const resolvedRoot = resolve(root)
  return rootIsFile ? resolvedTarget === resolvedRoot : resolvedTarget.startsWith(`${resolvedRoot}${sep}`)
}
