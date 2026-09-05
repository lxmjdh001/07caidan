import type { ChannelKind } from '@shared/domain'
import type { ChannelAdapter } from '../core/channel-adapter'
import type { Logger } from '../core/logger'
import type { AccountFingerprint } from '@shared/settings'

export interface ChannelPluginContext {
  /** 该渠道可自由使用的数据目录（凭证等） */
  dataDir: string
  logger: Logger
  /** 读取该账号的最新配置（代理、设备名、凭证等）。做成函数以便设置变更后重连即生效。 */
  getAccountConfig: () => {
    proxyUrl?: string
    deviceLabel?: string
    fingerprint?: AccountFingerprint
    credentials?: Record<string, string>
  }
  /** 保存渠道下载的媒体，返回 mediaId */
  saveMedia: (data: Buffer, ext: string) => Promise<string>
  /** 后台服务地址与令牌（LINE 等需公网 Webhook 中转的平台用） */
  getBackend: () => { url?: string; token?: string }
  /** 回写该账号的凭证（如 Telegram 登录后的会话串），适配器自持久化用 */
  saveCredentials: (credentials: Record<string, string>) => Promise<void>
  /** 全局默认值（如应用级 Telegram API 凭证），账号未单独配置时回退到此 */
  getDefaults?: () => { telegramApiId?: string; telegramApiHash?: string }
  /** 在带固定代理和独立持久化分区的内置窗口打开 OAuth，不使用共享系统浏览器。 */
  openOAuth: (url: string) => Promise<void>
}

/** 凭证字段描述（非扫码类平台，UI 据此渲染输入表单） */
export interface CredentialField {
  key: string
  label: string
  placeholder?: string
  secret?: boolean
  /** 高级项：UI 默认折叠隐藏，留空走内置默认值 */
  advanced?: boolean
}

/**
 * 渠道插件描述。新增平台 = 新增一个实现此接口的模块并在 plugins/index 注册，
 * 核心层与 UI 不需要任何改动。
 */
export interface ChannelPlugin {
  kind: ChannelKind
  displayName: string
  /**
   * 登录方式：
   * - qr: 扫码（WhatsApp）
   * - credentials: 填静态凭证（Telegram Bot Token / LINE 密钥）
   * - phone_code: 手机号 → 验证码 →（可选）两步密码（Telegram 普通账号）
   * - oauth: 在独立指纹与固定代理的内置隔离窗口完成官方授权
   */
  authType: 'qr' | 'credentials' | 'phone_code' | 'oauth'
  /** authType 为 credentials 时需要的字段 */
  credentialFields?: CredentialField[]
  createAdapter(accountId: string, ctx: ChannelPluginContext): ChannelAdapter
}

export class ChannelRegistry {
  private readonly plugins = new Map<ChannelKind, ChannelPlugin>()

  register(plugin: ChannelPlugin): void {
    if (this.plugins.has(plugin.kind)) {
      throw new Error(`渠道插件重复注册: ${plugin.kind}`)
    }
    this.plugins.set(plugin.kind, plugin)
  }

  get(kind: ChannelKind): ChannelPlugin {
    const plugin = this.plugins.get(kind)
    if (!plugin) throw new Error(`未注册的渠道插件: ${kind}`)
    return plugin
  }

  has(kind: ChannelKind): boolean {
    return this.plugins.has(kind)
  }

  list(): ChannelPlugin[] {
    return [...this.plugins.values()]
  }
}
