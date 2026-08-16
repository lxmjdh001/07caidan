import type { ChannelState, Conversation, UnifiedMessage } from './domain'
import type { AppSettings } from './settings'

/** 主进程 → 渲染进程 推送事件所用的 IPC channel 名 */
export const OMNI_EVENT_CHANNEL = 'omni:event'

/** 渲染进程 → 主进程 的调用方法名（ipcMain.handle 注册名与之一一对应） */
export const IPC_METHODS = {
  listChannels: 'omni:listChannels',
  listChannelPlugins: 'omni:listChannelPlugins',
  startChannel: 'omni:startChannel',
  submitAuthInput: 'omni:submitAuthInput',
  setLoginMode: 'omni:setLoginMode',
  logoutChannel: 'omni:logoutChannel',
  addAccount: 'omni:addAccount',
  removeAccount: 'omni:removeAccount',
  listConversations: 'omni:listConversations',
  listMessages: 'omni:listMessages',
  sendText: 'omni:sendText',
  previewOutbound: 'omni:previewOutbound',
  markRead: 'omni:markRead',
  sendMedia: 'omni:sendMedia',
  setConversationLang: 'omni:setConversationLang',
  getSettings: 'omni:getSettings',
  updateSettings: 'omni:updateSettings',
  listTranslators: 'omni:listTranslators',
  authState: 'omni:authState',
  authConfig: 'omni:authConfig',
  authSendCode: 'omni:authSendCode',
  authRegister: 'omni:authRegister',
  authLogin: 'omni:authLogin',
  authLogout: 'omni:authLogout',
  campaignCall: 'omni:campaignCall'
} as const

export type OmniEvent =
  | { type: 'message:new'; message: UnifiedMessage; conversation: Conversation }
  | { type: 'message:updated'; message: UnifiedMessage }
  | { type: 'conversation:updated'; conversation: Conversation }
  | { type: 'channel:state'; state: ChannelState }
  | { type: 'channel:removed'; key: string }

export interface TranslatorInfo {
  id: string
  displayName: string
}

/** 渠道插件元信息（UI 渲染平台选择与凭证表单） */
export interface ChannelPluginInfo {
  kind: string
  displayName: string
  authType: 'qr' | 'credentials' | 'phone_code'
  credentialFields?: Array<{
    key: string
    label: string
    placeholder?: string
    secret?: boolean
    /** 高级项：默认折叠，普通用户不用填 */
    advanced?: boolean
  }>
}

/** 客户端账号登录状态 */
export interface AuthState {
  authenticated: boolean
  email?: string
  /** 后台地址（可编辑，记住上次） */
  serverUrl: string
}

export interface AuthResult {
  ok: boolean
  error?: string
}

/** 出站翻译预览：已完成翻译但尚未发送 */
export interface OutboundPreview {
  /** 将实际发出的文本（译文；未翻译时等于 original） */
  send: string
  /** 坐席输入的原文 */
  original: string
  /** 执行翻译的引擎名；为空表示没有发生翻译 */
  engine?: string
  /** 解析出的目标语言 */
  targetLang: string
}

/** preload 暴露到 window.omni 的 API，渲染进程唯一的主进程入口 */
export interface OmniApi {
  /** 运行平台（darwin / win32 / linux），用于标题栏等平台差异化渲染 */
  platform: string
  listChannels(): Promise<ChannelState[]>
  /** 可用渠道插件（平台类型 + 凭证字段） */
  listChannelPlugins(): Promise<ChannelPluginInfo[]>
  startChannel(key: string): Promise<void>
  /** 提交交互式登录输入（Telegram 普通账号的手机号/验证码/两步密码） */
  submitAuthInput(key: string, value: string): Promise<void>
  /** 切换登录方式（Telegram：'qr' 扫码 / 'phone' 手机号），会重启登录流程 */
  setLoginMode(key: string, mode: 'qr' | 'phone'): Promise<void>
  logoutChannel(key: string): Promise<void>
  /** 新增一个账号（当前支持 whatsapp），返回其 channel key（如 whatsapp:wa1abc） */
  addAccount(channel: string): Promise<string>
  /** 删除账号：退出登录 + 移除（主账号 whatsapp:main 不可删除；聊天记录保留） */
  removeAccount(key: string): Promise<void>
  listConversations(): Promise<Conversation[]>
  listMessages(conversationId: string, limit?: number): Promise<UnifiedMessage[]>
  /** prepared 传入预览结果时直接按其发送（不再重复翻译） */
  sendText(
    conversationId: string,
    text: string,
    prepared?: OutboundPreview
  ): Promise<UnifiedMessage>
  /** 出站翻译预览：翻译但不发送 */
  previewOutbound(conversationId: string, text: string): Promise<OutboundPreview>
  /** 弹出文件选择框并发送所选媒体；用户取消返回 null */
  sendMedia(conversationId: string): Promise<UnifiedMessage | null>
  /** 设置会话的客户语言（null = 清除，回到自动） */
  setConversationLang(conversationId: string, lang: string | null): Promise<void>
  markRead(conversationId: string): Promise<void>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  listTranslators(): Promise<TranslatorInfo[]>
  /** 当前登录状态（token 存在即已登录） */
  authState(): Promise<AuthState>
  /** 拉取后台配置（是否需要邮箱验证），决定注册界面是否显示发送验证码 */
  authConfig(serverUrl: string): Promise<{ requireEmailVerify: boolean } | { error: string }>
  /** 发送邮箱验证码 */
  authSendCode(serverUrl: string, email: string): Promise<AuthResult>
  /** 注册（可带验证码），成功即登录 */
  authRegister(serverUrl: string, email: string, password: string, code?: string): Promise<AuthResult>
  /** 邮箱密码登录 */
  authLogin(serverUrl: string, email: string, password: string): Promise<AuthResult>
  /** 退出登录 */
  authLogout(): Promise<void>
  /**
   * 工单 / 重粉库接口的统一入口。
   * 走单个通道而不是给每个方法开一条 IPC —— 这些调用全是「转发到后台」，
   * 逐个开通道只会让 preload 和 handler 长出十几段一模一样的样板代码。
   */
  campaign<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  /** 订阅主进程推送，返回取消订阅函数 */
  onEvent(cb: (evt: OmniEvent) => void): () => void
}
