import type { ChannelState, Conversation, UnifiedMessage } from './domain'
import type { AppSettings } from './settings'

/** 主进程 → 渲染进程 推送事件所用的 IPC channel 名 */
export const OMNI_EVENT_CHANNEL = 'omni:event'

/** 渲染进程 → 主进程 的调用方法名（ipcMain.handle 注册名与之一一对应） */
export const IPC_METHODS = {
  listChannels: 'omni:listChannels',
  startChannel: 'omni:startChannel',
  logoutChannel: 'omni:logoutChannel',
  listConversations: 'omni:listConversations',
  listMessages: 'omni:listMessages',
  sendText: 'omni:sendText',
  markRead: 'omni:markRead',
  sendMedia: 'omni:sendMedia',
  getSettings: 'omni:getSettings',
  updateSettings: 'omni:updateSettings',
  listTranslators: 'omni:listTranslators'
} as const

export type OmniEvent =
  | { type: 'message:new'; message: UnifiedMessage; conversation: Conversation }
  | { type: 'message:updated'; message: UnifiedMessage }
  | { type: 'conversation:updated'; conversation: Conversation }
  | { type: 'channel:state'; state: ChannelState }

export interface TranslatorInfo {
  id: string
  displayName: string
}

/** preload 暴露到 window.omni 的 API，渲染进程唯一的主进程入口 */
export interface OmniApi {
  /** 运行平台（darwin / win32 / linux），用于标题栏等平台差异化渲染 */
  platform: string
  listChannels(): Promise<ChannelState[]>
  startChannel(key: string): Promise<void>
  logoutChannel(key: string): Promise<void>
  listConversations(): Promise<Conversation[]>
  listMessages(conversationId: string, limit?: number): Promise<UnifiedMessage[]>
  sendText(conversationId: string, text: string): Promise<UnifiedMessage>
  /** 弹出文件选择框并发送所选媒体；用户取消返回 null */
  sendMedia(conversationId: string): Promise<UnifiedMessage | null>
  markRead(conversationId: string): Promise<void>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  listTranslators(): Promise<TranslatorInfo[]>
  /** 订阅主进程推送，返回取消订阅函数 */
  onEvent(cb: (evt: OmniEvent) => void): () => void
}
