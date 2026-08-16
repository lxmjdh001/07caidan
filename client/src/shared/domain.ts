/**
 * 统一消息模型 —— 所有渠道（WhatsApp / Telegram / LINE / ...）的消息
 * 都会被各自的适配器转换成这里定义的结构。核心层与 UI 只认识这些类型。
 */

/** telegram = 普通账号（MTProto）；telegram_bot = Bot API */
export type ChannelKind = 'whatsapp' | 'telegram' | 'telegram_bot' | 'line'

export type ChannelStatus =
  | 'stopped'
  | 'connecting'
  | 'waiting_qr'
  /** 等待用户填写凭证（Bot Token / LINE 密钥等） */
  | 'need_credentials'
  /** 等待输入手机号（Telegram 普通账号登录第一步） */
  | 'waiting_phone'
  /** 等待输入短信/应用内验证码 */
  | 'waiting_code'
  /** 等待输入两步验证密码 */
  | 'waiting_password'
  /** 已生成配对码，等待用户在手机 App 内输入（WhatsApp 手机号登录） */
  | 'waiting_pairing_code'
  | 'connected'
  | 'logged_out'
  | 'error'

export interface ChannelState {
  kind: ChannelKind
  accountId: string
  status: ChannelStatus
  /** 状态附加说明（如错误信息、重连提示） */
  detail?: string
  /** 等待扫码时的二维码图片（data URL） */
  qrDataUrl?: string
  /** 手机号登录时生成的配对码，用户需在手机 App 内输入 */
  pairingCode?: string
  /** 登录后的账号显示名 */
  selfName?: string
  /**
   * 本账号对外的联系方式（WhatsApp 为手机号、Telegram 为用户名）。
   * 用于生成客户找上门的入口链接，登录后才有；LINE 拿不到，需用户自己填。
   */
  selfHandle?: string
}

export type MessageDirection = 'in' | 'out'

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker'

export type MessageBody =
  | { type: 'text'; text: string }
  | {
      type: 'media'
      mediaType: MediaType
      caption?: string
      /** 本地媒体文件 ID（MediaStore 内的文件名）。未下载完成/失败时为空，UI 显示占位 */
      mediaId?: string
      mimeType?: string
      fileName?: string
      /** 语音/视频时长（秒），用于播放条展示 */
      durationSec?: number
      /** 语音转文字结果（ASR），按需生成后缓存在消息上 */
      transcript?: string
    }
  | { type: 'unsupported'; description: string }

export interface Translation {
  text: string
  sourceLang?: string
  targetLang: string
  engine: string
}

export interface UnifiedMessage {
  /**
   * 平台广告上下文识别出的来源（目前仅 WhatsApp Click-to-WhatsApp 有）。
   * 临时字段：由适配器映射时填入，ChannelManager 消费后写到会话上，不入库。
   */
  leadSource?: LeadSourceInfo
  /** 内部唯一 ID */
  id: string
  /** 平台侧消息 ID（用于去重、状态回执） */
  externalId?: string
  channel: ChannelKind
  accountId: string
  conversationId: string
  direction: MessageDirection
  /** 发送者显示名（群聊中区分成员用） */
  authorName?: string
  body: MessageBody
  translation?: Translation
  /** epoch 毫秒 */
  timestamp: number
  status: MessageStatus
}

/** 客户来源（投放归因），只在首条入站消息时识别一次 */
export interface LeadSourceInfo {
  /** 归一化的来源标识，用于分组统计 */
  code: string
  /** ad = 平台广告上下文（最可靠）；code = 预填文案里的追踪码 */
  via: 'ad' | 'code'
  clickId?: string
  sourceUrl?: string
  title?: string
}

export interface Conversation {
  id: string
  channel: ChannelKind
  accountId: string
  /** 平台侧会话 ID（WhatsApp 为 jid，Telegram 为 chat id 等） */
  externalChatId: string
  title: string
  /**
   * 客户的规范唯一标识（如 wa:+17759276114），跨本产品内所有己方账号稳定。
   * 群聊/机器人会话为空。用于识别"同一客户在不同账号找过我"。
   */
  contactId?: string
  /** 对方头像（MediaStore 内的文件 ID），未获取到则用首字母占位 */
  avatarMediaId?: string
  /** 自动检测到的客户语言（来自入站消息翻译时的源语言识别） */
  detectedLang?: string
  /** 手动指定的客户语言（会话级设置，优先级最高）；空 = 自动 */
  langOverride?: string
  /** 投放归因：这个客户从哪个广告/链接来的（首条入站消息识别后固定不变） */
  leadSource?: LeadSourceInfo
  /** 该会话是否开启 AI 自动回复（还需全局开关同时开启） */
  autoReply?: boolean
  isGroup: boolean
  lastMessageAt: number
  lastMessagePreview: string
  unreadCount: number
}

/** 会话内部 ID：`渠道:账号:平台会话ID`。externalChatId 自身可含冒号，解析时须用 parseConversationId。 */
export function conversationId(
  channel: ChannelKind,
  accountId: string,
  externalChatId: string
): string {
  return `${channel}:${accountId}:${externalChatId}`
}

export interface ParsedConversationId {
  channel: ChannelKind
  accountId: string
  externalChatId: string
}

export function parseConversationId(id: string): ParsedConversationId {
  const first = id.indexOf(':')
  const second = id.indexOf(':', first + 1)
  if (first < 0 || second < 0) {
    throw new Error(`非法的会话 ID: ${id}`)
  }
  return {
    channel: id.slice(0, first) as ChannelKind,
    accountId: id.slice(first + 1, second),
    externalChatId: id.slice(second + 1)
  }
}

/** 渠道实例 key：`渠道:账号` */
export function channelKey(kind: ChannelKind, accountId: string): string {
  return `${kind}:${accountId}`
}

const MEDIA_PREVIEW: Record<MediaType, string> = {
  image: '[图片]',
  video: '[视频]',
  audio: '[语音]',
  document: '[文件]',
  sticker: '[贴纸]'
}

/** 会话列表中展示的最后一条消息摘要 */
export function previewOf(body: MessageBody): string {
  switch (body.type) {
    case 'text':
      return body.text
    case 'media':
      return body.caption ? `${MEDIA_PREVIEW[body.mediaType]} ${body.caption}` : MEDIA_PREVIEW[body.mediaType]
    case 'unsupported':
      return `[暂不支持的消息: ${body.description}]`
  }
}
