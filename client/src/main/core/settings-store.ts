import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  type AccountConfig,
  type AppSettings,
  type ProxyAsset
} from '@shared/settings'

/**
 * 应用设置存储（JSON 文件，原子写入）。
 */
export class SettingsStore {
  private readonly filePath: string
  private settings: AppSettings = structuredClone(DEFAULT_SETTINGS)
  private pendingPersist: Promise<void> = Promise.resolve()

  constructor(dir: string) {
    this.filePath = join(dir, 'settings.json')
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      // 与默认值深合并，保证升级后新增字段有值
      this.settings = mergeSettings(structuredClone(DEFAULT_SETTINGS), parsed)
      this.settings.platformOrder = completePlatformOrder(this.settings.platformOrder)
      const migratedProxyAssets = migrateLegacyAccountProxies(this.settings)
      // 账号代理可能包含用户名和密码；升级旧文件时立即收紧为仅当前系统用户可读写。
      await chmod(this.filePath, 0o600).catch(() => undefined)
      if (migratedProxyAssets) await this.persist()
    } catch {
      // 首次运行：使用默认值
    }
  }

  get(): AppSettings {
    return structuredClone(this.settings)
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = mergeSettings(this.settings, patch)
    await this.persist()
    return this.get()
  }

  /** 删除账号配置（合并语义做不到删除，单独提供） */
  async removeAccount(key: string): Promise<AppSettings> {
    delete this.settings.accounts[key]
    await this.persist()
    return this.get()
  }

  /**
   * 用云端账号目录协调后的完整集合替换注册表。
   * 调用方必须先把本机代理/指纹/凭证合并进去；这里不用 deepMerge，才能落实远端删除墓碑。
   */
  async replaceAccounts(accounts: Record<string, AccountConfig>): Promise<AppSettings> {
    this.settings.accounts = structuredClone(accounts)
    await this.persist()
    return this.get()
  }

  /** 原子替换账号网络快照与独立代理库，支持解除关联和删除资产。 */
  async replaceNetworkConfig(
    accounts: Record<string, AccountConfig>,
    proxyAssets: Record<string, ProxyAsset>
  ): Promise<AppSettings> {
    this.settings.accounts = structuredClone(accounts)
    this.settings.proxyAssets = structuredClone(proxyAssets)
    await this.persist()
    return this.get()
  }

  /**
   * 凭证必须整体替换，不能走通用 deepMerge。
   *
   * 登录成功后适配器会用会话令牌替换一次性密码；若深合并，旧 password
   * 会残留在磁盘上，logout 传入空对象也无法真正清空凭证。
   */
  async replaceAccountCredentials(
    key: string,
    credentials: Record<string, string>
  ): Promise<AppSettings> {
    const current = this.settings.accounts[key] ?? {}
    this.settings.accounts[key] = {
      ...current,
      credentials: structuredClone(credentials)
    }
    await this.persist()
    return this.get()
  }

  private async persist(): Promise<void> {
    // 配置同步回写与 UI 保存可能同时发生；为每次更新先截取快照，再串行执行原子替换，
    // 避免两个写入争抢同一个 .tmp 文件并随机报 ENOENT。
    const snapshot = JSON.stringify(this.settings, null, 2)
    const next = this.pendingPersist.then(async () => {
      const tmp = `${this.filePath}.tmp`
      await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.filePath)
      await chmod(this.filePath, 0o600).catch(() => undefined)
    })
    this.pendingPersist = next.catch(() => undefined)
    await next
  }

  accountConfig(key: string): AccountConfig {
    return this.settings.accounts[key] ?? {}
  }
}

/**
 * 0.2.13 及更早版本把代理直接挂在账号上。升级后为每条旧配置创建独立资产，
 * 同时保留账号里的运行时快照，平台适配器无需在迁移期间改变读取方式。
 */
function migrateLegacyAccountProxies(settings: AppSettings): boolean {
  let changed = false
  if (!settings.proxyAssets || typeof settings.proxyAssets !== 'object' || Array.isArray(settings.proxyAssets)) {
    settings.proxyAssets = {}
    changed = true
  }

  for (const [accountKey, account] of Object.entries(settings.accounts)) {
    const linked = account.proxyId ? settings.proxyAssets[account.proxyId] : undefined
    if (linked?.proxyUrl) {
      if (account.proxyUrl !== linked.proxyUrl) {
        account.proxyUrl = linked.proxyUrl
        changed = true
      }
      if (account.proxyNote !== linked.note) {
        account.proxyNote = linked.note
        changed = true
      }
      if (account.proxyCreatedAt !== linked.createdAt) {
        account.proxyCreatedAt = linked.createdAt
        changed = true
      }
      if (JSON.stringify(account.proxyVerification) !== JSON.stringify(linked.verification)) {
        account.proxyVerification = linked.verification ? structuredClone(linked.verification) : undefined
        changed = true
      }
      continue
    }

    const proxyUrl = account.proxyUrl?.trim()
    if (!proxyUrl) {
      if (account.proxyId) {
        delete account.proxyId
        changed = true
      }
      continue
    }

    const preferred = validProxyAssetId(account.proxyId) ? account.proxyId! : legacyProxyAssetId(accountKey, proxyUrl)
    const id = uniqueProxyAssetId(preferred, settings.proxyAssets, proxyUrl)
    const createdAt = account.proxyCreatedAt ?? account.proxyVerification?.checkedAt ?? Date.now()
    settings.proxyAssets[id] = {
      id,
      proxyUrl,
      note: account.proxyNote,
      createdAt,
      updatedAt: account.proxyVerification?.checkedAt ?? createdAt,
      verification: account.proxyVerification ? structuredClone(account.proxyVerification) : undefined
    }
    account.proxyId = id
    changed = true
  }
  return changed
}

function validProxyAssetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
}

function legacyProxyAssetId(accountKey: string, proxyUrl: string): string {
  const digest = createHash('sha256').update(`${accountKey}\0${proxyUrl}`).digest('hex').slice(0, 16)
  return `legacy-${digest}`
}

function uniqueProxyAssetId(
  preferred: string,
  assets: Record<string, ProxyAsset>,
  proxyUrl: string
): string {
  let id = preferred
  let suffix = 2
  while (true) {
    const existing = assets[id]
    if (!existing || existing.proxyUrl === proxyUrl) return id
    id = `${preferred}-${suffix}`
    suffix += 1
  }
}

/** 旧版本保存的数组不含后来新增的平台；升级时保持原顺序并把缺项补到末尾。 */
function completePlatformOrder(current: AppSettings['platformOrder']): AppSettings['platformOrder'] {
  const supported = DEFAULT_SETTINGS.platformOrder
  const order = current.filter(
    (kind, index) => supported.includes(kind) && current.indexOf(kind) === index
  )
  for (const kind of supported) {
    if (!order.includes(kind)) order.push(kind)
  }
  return order
}

/** 递归合并：patch 的对象字段与 base 合并，标量/数组直接覆盖 */
function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return deepMerge(base as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as AppSettings
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const prev = out[key]
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      prev !== null &&
      typeof prev === 'object' &&
      !Array.isArray(prev)
    ) {
      out[key] = deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}
