import type { ChannelState, Conversation, UnifiedMessage } from './domain'
import type { AppSettings } from './settings'
import type {
  AccountNetworkState,
  ConfigureAccountNetworkInput,
  ConfigureAccountNetworkResult,
  ProxyProbe,
  SaveProxyAssetInput,
  SaveProxyAssetResult
} from './network'

/** 主进程 → 渲染进程 推送事件所用的 IPC channel 名 */
export const OMNI_EVENT_CHANNEL = 'omni:event'

/** 渲染进程 → 主进程 的调用方法名（ipcMain.handle 注册名与之一一对应） */
export const IPC_METHODS = {
  listChannels: 'omni:listChannels',
  listChannelPlugins: 'omni:listChannelPlugins',
  startChannel: 'omni:startChannel',
  refreshChannelProfile: 'omni:refreshChannelProfile',
  submitAuthInput: 'omni:submitAuthInput',
  beginOAuth: 'omni:beginOAuth',
  setLoginMode: 'omni:setLoginMode',
  logoutChannel: 'omni:logoutChannel',
  addAccount: 'omni:addAccount',
  removeAccount: 'omni:removeAccount',
  setAccountEnabled: 'omni:setAccountEnabled',
  listAccountNetworks: 'omni:listAccountNetworks',
  testProxy: 'omni:testProxy',
  saveProxyAsset: 'omni:saveProxyAsset',
  deleteProxyAsset: 'omni:deleteProxyAsset',
  unlinkAccountProxy: 'omni:unlinkAccountProxy',
  setProxyAssetBindings: 'omni:setProxyAssetBindings',
  testAccountProxy: 'omni:testAccountProxy',
  configureAccountNetwork: 'omni:configureAccountNetwork',
  listGroups: 'omni:listGroups',
  createGroup: 'omni:createGroup',
  listConversations: 'omni:listConversations',
  listMessages: 'omni:listMessages',
  sendText: 'omni:sendText',
  previewOutbound: 'omni:previewOutbound',
  markRead: 'omni:markRead',
  sendMedia: 'omni:sendMedia',
  sendVoice: 'omni:sendVoice',
  transcribeVoice: 'omni:transcribeVoice',
  setConversationLang: 'omni:setConversationLang',
  setConversationAutoReply: 'omni:setConversationAutoReply',
  setConversationPinned: 'omni:setConversationPinned',
  setConversationMuted: 'omni:setConversationMuted',
  clearConversation: 'omni:clearConversation',
  deleteConversation: 'omni:deleteConversation',
  inheritAccountConversations: 'omni:inheritAccountConversations',
  updateConversationProfile: 'omni:updateConversationProfile',
  getSettings: 'omni:getSettings',
  updateSettings: 'omni:updateSettings',
  listTranslators: 'omni:listTranslators',
  authState: 'omni:authState',
  authRefresh: 'omni:authRefresh',
  crispAvailable: 'omni:crispAvailable',
  crispOpen: 'omni:crispOpen',
  authConfig: 'omni:authConfig',
  authSendCode: 'omni:authSendCode',
  authRegister: 'omni:authRegister',
  authLogin: 'omni:authLogin',
  authForgotPassword: 'omni:authForgotPassword',
  authResetPassword: 'omni:authResetPassword',
  authLogout: 'omni:authLogout',
  campaignCall: 'omni:campaignCall',
  billingCall: 'omni:billingCall',
  setUnreadTotal: 'omni:setUnreadTotal',
  appInfo: 'omni:appInfo',
  checkUpdates: 'omni:checkUpdates',
  installUpdate: 'omni:installUpdate'
  ,quitApp: 'omni:quitApp'
} as const

export type OmniEvent =
  | { type: 'message:new'; message: UnifiedMessage; conversation: Conversation }
  | { type: 'message:updated'; message: UnifiedMessage }
  | { type: 'conversation:updated'; conversation: Conversation }
  | { type: 'conversation:removed'; conversationId: string }
  | { type: 'channel:state'; state: ChannelState }
  | { type: 'channel:removed'; key: string }
  | { type: 'network:state'; state: AccountNetworkState }
  /** 用户点击系统通知 → 打开该会话 */
  | { type: 'conversation:open'; conversationId: string }
  /** 自动更新状态变化 */
  | { type: 'update:state'; state: import('./update').UpdateStateInfo }

export interface TranslatorInfo {
  id: string
  displayName: string
}

/** 渠道插件元信息（UI 渲染平台选择与凭证表单） */
export interface ChannelPluginInfo {
  kind: string
  displayName: string
  authType: 'qr' | 'credentials' | 'phone_code' | 'oauth'
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
  /** 角色：boss / agent / 自定义角色 id */
  role?: string
  /** 有效权限（见 server 端 CLIENT_PERMISSIONS） */
  permissions?: string[]
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
  /** 翻译失败原因；有值时不会发送原文。 */
  error?: string
}

/** preload 暴露到 window.omni 的 API，渲染进程唯一的主进程入口 */
export interface OmniApi {
  /** 运行平台（darwin / win32 / linux），用于标题栏等平台差异化渲染 */
  platform: string
  listChannels(): Promise<ChannelState[]>
  /** 提交工单前强制刷新账号自身头像等资料 */
  refreshChannelProfile(key: string): Promise<ChannelState>
  /** 可用渠道插件（平台类型 + 凭证字段） */
  listChannelPlugins(): Promise<ChannelPluginInfo[]>
  startChannel(key: string): Promise<void>
  /** 提交交互式登录输入（Telegram 普通账号的手机号/验证码/两步密码） */
  submitAuthInput(key: string, value: string): Promise<void>
  /** 在该账号独立指纹与固定代理的内置隔离窗口完成 OAuth 授权。 */
  beginOAuth(key: string): Promise<void>
  /** 切换登录方式（Telegram：'qr' 扫码 / 'phone' 手机号），会重启登录流程 */
  setLoginMode(key: string, mode: 'qr' | 'phone'): Promise<void>
  logoutChannel(key: string): Promise<void>
  /** 新增一个账号（当前支持 whatsapp），返回其 channel key（如 whatsapp:wa1abc） */
  addAccount(channel: string): Promise<string>
  /** 删除账号：退出登录并从账号列表移除；聊天记录保留。 */
  removeAccount(key: string): Promise<void>
  /** 启用或禁用账号的连接与消息接收；禁用不会清除登录凭证。 */
  setAccountEnabled(key: string, enabled: boolean): Promise<void>
  /** 查询每个平台账号的独立代理/断网隔离状态。 */
  listAccountNetworks(): Promise<AccountNetworkState[]>
  /** 检测独立代理资产，不要求选择账号，不保存任何数据。 */
  testProxy(proxyUrl: string): Promise<ProxyProbe>
  /** 新增或编辑独立代理资产；普通保存不等待网络检测。 */
  saveProxyAsset(input: SaveProxyAssetInput): Promise<SaveProxyAssetResult>
  /** 删除代理资产；已关联账号会先安全断开并解除关联。 */
  deleteProxyAsset(id: string): Promise<AppSettings>
  /** 解除账号与代理资产的关联，并立即清除旧网络门禁状态。 */
  unlinkAccountProxy(key: string): Promise<AppSettings>
  /** 一次性保存某条代理的全部账号关联；支持跨平台、多账号并原子更新配置。 */
  setProxyAssetBindings(assetId: string, accountKeys: string[]): Promise<AppSettings>
  /** 只检测候选代理，不保存配置、不登录平台，也不改变当前账号连接。 */
  testAccountProxy(key: string, proxyUrl: string): Promise<import('./network').AccountProxyTestResult>
  /** 保存账号代理并按需连接；skipTest=true 时直接由平台连接判断是否可用。 */
  configureAccountNetwork(
    key: string,
    input: ConfigureAccountNetworkInput
  ): Promise<ConfigureAccountNetworkResult>
  listGroups(key: string): Promise<Conversation[]>
  createGroup(key: string, subject: string, participantIds: string[]): Promise<Conversation>
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
  /** 发送录制的语音条（MediaRecorder 产物） */
  sendVoice(
    conversationId: string,
    data: ArrayBuffer,
    mimeType: string,
    durationSec: number
  ): Promise<UnifiedMessage>
  /** 语音消息转文字（结果缓存在消息上，同一条只计费一次） */
  transcribeVoice(
    conversationId: string,
    messageId: string
  ): Promise<{ ok: boolean; transcript?: string; error?: string }>
  /** 设置会话的客户语言（null = 清除，回到自动） */
  setConversationLang(conversationId: string, lang: string | null): Promise<void>
  /** 会话级 AI 自动回复开关（还需设置里的全局开关同时开启） */
  setConversationAutoReply(conversationId: string, on: boolean): Promise<void>
  /** 设置会话是否置顶 */
  setConversationPinned(conversationId: string, pinned: boolean): Promise<void>
  setConversationMuted(conversationId: string, muted: boolean): Promise<void>
  clearConversation(conversationId: string): Promise<void>
  deleteConversation(conversationId: string): Promise<void>
  inheritAccountConversations(sourceAccountKey: string, targetAccountKey: string): Promise<{ conversations: number; messages: number }>
  updateConversationProfile(conversationId: string, title: string, customerNote: string): Promise<void>
  markRead(conversationId: string): Promise<void>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  listTranslators(): Promise<TranslatorInfo[]>
  /** 当前登录状态（token 存在即已登录） */
  authState(): Promise<AuthState>
  /** 刷新角色与权限（启动时调用；会话失效时顺带清理登录态） */
  authRefresh(): Promise<AuthState>
  /** 在线客服（Crisp）是否已在后台配置 */
  crispAvailable(): Promise<boolean>
  /** 打开在线客服窗口（带套餐/版本/设备等会话数据） */
  crispOpen(): Promise<{ ok: boolean; error?: string }>
  /** 拉取后台配置（是否需要邮箱验证），决定注册界面是否显示发送验证码 */
  authConfig(serverUrl: string): Promise<{ requireEmailVerify: boolean } | { error: string }>
  /** 发送邮箱验证码 */
  authSendCode(serverUrl: string, email: string): Promise<AuthResult>
  /** 注册（可带验证码），成功即登录 */
  authRegister(serverUrl: string, email: string, password: string, code?: string, inviteCode?: string): Promise<AuthResult>
  /** 邮箱密码登录 */
  authLogin(serverUrl: string, email: string, password: string): Promise<AuthResult>
  /** 找回密码：发送验证码（无论邮箱是否注册都返回 ok，防探测） */
  authForgotPassword(serverUrl: string, email: string): Promise<AuthResult>
  /** 找回密码：验码改密；成功后所有旧会话失效 */
  authResetPassword(
    serverUrl: string,
    email: string,
    code: string,
    password: string
  ): Promise<AuthResult>
  /** 退出登录 */
  authLogout(): Promise<void>
  /**
   * 工单 / 重粉库接口的统一入口。
   * 走单个通道而不是给每个方法开一条 IPC —— 这些调用全是「转发到后台」，
   * 逐个开通道只会让 preload 和 handler 长出十几段一模一样的样板代码。
   */
  campaign<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  /** 计费接口统一入口（同 campaign 的白名单转发模式） */
  billing<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  /** 上报总未读数，主进程据此更新程序坞/任务栏角标 */
  setUnreadTotal(total: number): Promise<void>
  /** 应用信息（版本号等，设置页"关于"展示） */
  appInfo(): Promise<{ version: string; updateState: import('./update').UpdateStateInfo }>
  /** 手动检查更新 */
  checkUpdates(): Promise<void>
  /** 更新已就绪时：立即重启安装 */
  installUpdate(): Promise<void>
  /** 请求退出桌面应用（由主进程统一执行） */
  quitApp(): Promise<void>
  /** 订阅主进程推送，返回取消订阅函数 */
  onEvent(cb: (evt: OmniEvent) => void): () => void
}
