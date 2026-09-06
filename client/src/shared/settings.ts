/** 应用设置类型（主进程存储、渲染进程设置页共用） */

import type { ChannelKind } from './domain'

export interface TranslationConfig {
  /** 翻译插件 id：google-free（默认，免费）/ deepl / google-cloud / llm / custom-http / off */
  engine: string
  /** 收到客户消息自动译为 displayLang */
  inboundEnabled: boolean
  /** 发送时自动译为客户语言 */
  outboundEnabled: boolean
  /** 发送前显示译文预览，确认后才发出（关闭则直发） */
  confirmBeforeSend: boolean
  /** 坐席本地语言（收到的消息译成这个） */
  displayLang: string
  /** 全局默认客户语言：未识别到客户语言且账号未配置时使用 */
  targetLangDefault: string
  /** 各引擎配置 */
  custom: { url: string; apiKey: string }
  deepl: { apiKey: string }
  googleCloud: { apiKey: string }
  llm: { baseUrl: string; apiKey: string; model: string }
}

/**
 * 单个平台账号的稳定设备身份。
 *
 * seed 用于派生协议层设备名和独立浏览器分区；只随加密账号环境保存到客户工作区，
 * 不作为明文偏好上传，也不会发送给平台；
 * id 是可展示的短标识，方便在代理管理页确认不同账号没有共用同一环境。
 */
export interface AccountFingerprint {
  id: string
  seed: string
  deviceName: string
  createdAt: number
}

/** 最近一次完全经代理完成的多目标连通性检测结果。 */
export interface ProxyVerification {
  /** 代理地址的不可逆摘要；地址或密码变更后旧检测结果自动失效。 */
  proxyHash: string
  /** 兼容旧版本记录；当前检测不再查询出口 IP。 */
  exitIp?: string
  checkedAt: number
  latencyMs: number
}

/** 独立代理资产；可先保存到代理库，之后再关联一个或多个平台账号。 */
export interface ProxyAsset {
  id: string
  /** 完整代理地址，可能包含认证信息；本机受限保存，并随加密账号环境跨设备恢复。 */
  proxyUrl: string
  note?: string
  createdAt: number
  updatedAt: number
  verification?: ProxyVerification
}

export interface AccountConfig {
  /** 是否暂停该账号的连接与消息接收；保留登录凭证，启用后可恢复 */
  disabled?: boolean
  /**
   * 该账号的独立代理，如 socks5://127.0.0.1:1080。
   * 平台账号不允许留空直连；缺失或断开时网络门禁会停止登录与消息连接。
   */
  proxyUrl?: string
  /** 关联的独立代理资产 ID；proxyUrl 是平台运行时使用的安全快照。 */
  proxyId?: string
  /** 代理资产表中的业务备注；不包含代理认证信息。 */
  proxyNote?: string
  /** 此账号首次成功绑定代理的时间。 */
  proxyCreatedAt?: number
  /** 每个账号独立且稳定的设备身份；创建账号时先生成，再允许打开登录。 */
  fingerprint?: AccountFingerprint
  /** 代理连通性检测记录；只用于界面展示，真正连接前仍会实时复检。 */
  proxyVerification?: ProxyVerification
  /** 该账号的默认客户语言（覆盖全局 targetLangDefault）；留空跟随全局 */
  defaultLang?: string
  /** 显示名（默认用登录后的账号名） */
  label?: string
  /**
   * 自定义设备名（WhatsApp「已关联的设备」里显示的浏览器名）。
   * 留空则按账号自动派生一个稳定且各账号不同的设备标识，用于多账号防关联。
   * 改动后需重新登录该账号才会以新设备名重新配对。
   */
  deviceLabel?: string
  /**
   * 平台凭证（非扫码类平台用）：
   * - Telegram: { botToken }
   * - LINE: { authToken }（本机扫码登录会话）
   * - KakaoTalk: 首次登录后仅保留本机设备身份与会话令牌，不保留密码
   * - Messenger / Instagram: 不写入此处，访问令牌只由服务器加密托管
   */
  credentials?: Record<string, string>
}

export interface SyncConfig {
  /** 是否把聊天记录同步到后台 */
  enabled: boolean
  /** 后台服务地址，如 https://api.example.com */
  serverUrl: string
  /** 同步鉴权令牌（客户端账号登录后下发） */
  token: string
  /** 登录账号邮箱 */
  email: string
  /** 是否同时上传媒体文件 */
  uploadMedia: boolean
  /** 登录账号角色（boss / agent / 自定义角色 id） */
  role?: string
  /** 登录账号的有效权限（服务端下发；界面按此显隐，真正的强制在服务端） */
  permissions?: string[]
  /** 是否把非敏感偏好同步到后台；平台凭证/会话由独立加密环境服务管理。 */
  cloudSync?: boolean
  /** 本地记账：上次与云端对齐的偏好版本时间戳（用于后写为准，不上云） */
  settingsSyncedAt?: number
}

/** AI 自动回复（全局开关 + 话术；按会话再开一层，两层都开才生效） */
export interface AutoReplyConfig {
  enabled: boolean
  /** 业务话术/身份设定，作为 system 提示发给模型 */
  systemPrompt: string
  /** 同一会话两次自动回复的最小间隔（秒），防连发与机器人互怼 */
  cooldownSec: number
  /**
   * 转人工关键词（逗号/换行分隔）。客户消息命中任一关键词时：
   * 停用该会话的自动回复并弹通知提醒客服接管。
   */
  handoffKeywords: string
}

/** 桌面通知与角标 */
export interface NotificationConfig {
  enabled: boolean
  /** 通知里是否展示消息正文；关掉只显示「[新消息]」，适合共用屏幕的场景 */
  showPreview: boolean
  sound: boolean
}

export interface QuickReply {
  id: string
  title: string
  text: string
  /** 可选分组，用于管理页和聊天快捷面板筛选。 */
  category?: string
}

/** 平台级默认凭证（账号未单独配置时回退到此） */
export interface PlatformDefaults {
  /** Telegram 应用级 API 凭证（my.telegram.org 申请），普通账号登录必需 */
  telegramApiId: string
  telegramApiHash: string
}

/** 界面主题：跟随系统 / 强制浅色 / 强制深色 */
export type ThemeMode = 'system' | 'light' | 'dark'

export interface AppSettings {
  /** 界面语言；'auto' = 跟随系统语言 */
  locale: string
  /** 界面主题，默认跟随系统 */
  theme: ThemeMode
  /** 左侧账号栏的平台分组顺序；只影响展示，不改变账号和聊天数据。 */
  platformOrder: ChannelKind[]
  translation: TranslationConfig
  notifications: NotificationConfig
  quickReplies: QuickReply[]
  autoReply: AutoReplyConfig
  sync: SyncConfig
  platform: PlatformDefaults
  /** 本机代理资产库；代理可先创建、检测，之后再关联平台账号。 */
  proxyAssets: Record<string, ProxyAsset>
  /**
   * 按渠道账号 key（如 whatsapp:main）的独立配置。
   * 这里的 key 集合同时是"账号注册表"：启动时为每个 key 创建适配器。
   * 空列表表示尚未添加任何平台账号；用户可按需添加和删除所有账号。
   */
  accounts: Record<string, AccountConfig>
}

export const DEFAULT_SETTINGS: AppSettings = {
  // 默认跟随系统语言与系统深浅色，首次启动不需要用户先去设置里点一遍
  locale: 'auto',
  theme: 'system',
  platformOrder: [
    'whatsapp',
    'telegram',
    'telegram_bot',
    'line',
    'kakaotalk',
    'facebook',
    'instagram',
    'tiktok',
    'x',
    'snapchat'
  ],
  translation: {
    engine: 'google-free',
    inboundEnabled: true,
    outboundEnabled: true,
    confirmBeforeSend: false,
    displayLang: 'zh-CN',
    targetLangDefault: 'en',
    custom: { url: '', apiKey: '' },
    deepl: { apiKey: '' },
    googleCloud: { apiKey: '' },
    llm: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '' }
  },
  notifications: { enabled: true, showPreview: true, sound: true },
  quickReplies: [
    { id: 'welcome', title: '欢迎语', text: '您好！请问有什么可以帮您的吗？' },
    { id: 'need-help', title: '需求确认', text: '您好，有什么需要我为您推荐或解答的吗？' },
    { id: 'wait', title: '稍等', text: '请稍等，我马上为您处理。' }
  ],
  autoReply: {
    enabled: false,
    systemPrompt:
      '你是一名专业客服。用客户使用的语言简短友好地回复，不要编造价格与承诺，拿不准时请客户稍等人工回复。',
    cooldownSec: 20,
    handoffKeywords: '人工, 转人工, 真人, human, agent, operator'
  },
  sync: { enabled: false, serverUrl: '', token: '', email: '', uploadMedia: true, cloudSync: true },
  platform: { telegramApiId: '', telegramApiHash: '' },
  proxyAssets: {},
  accounts: {}
}
