import type { ChannelKind } from '@shared/domain'
import type { ChannelAdapter } from '../core/channel-adapter'
import type { Logger } from '../core/logger'

export interface ChannelPluginContext {
  /** 该渠道可自由使用的数据目录（凭证等） */
  dataDir: string
  logger: Logger
  /** 读取该账号的最新配置（代理、设备名等）。做成函数以便设置变更后重连即生效。 */
  getAccountConfig: () => { proxyUrl?: string; deviceLabel?: string }
  /** 保存渠道下载的媒体，返回 mediaId */
  saveMedia: (data: Buffer, ext: string) => Promise<string>
}

/**
 * 渠道插件描述。新增平台 = 新增一个实现此接口的模块并在 plugins/index 注册，
 * 核心层与 UI 不需要任何改动。
 */
export interface ChannelPlugin {
  kind: ChannelKind
  displayName: string
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

  list(): ChannelPlugin[] {
    return [...this.plugins.values()]
  }
}
