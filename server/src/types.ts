/** 客户端同步上来的会话（与桌面端 domain 对齐的子集） */
export interface SyncConversation {
  id: string
  channel: string
  accountId: string
  contactId?: string
  /** 平台公开账号标识，例如 LINE 官方账号 @id。 */
  publicId?: string
  avatarMediaId?: string
  title: string
  isGroup: boolean
  detectedLang?: string
  /** null 表示显式清除手动语言设置。 */
  langOverride?: string | null
  autoReply?: boolean
  pinned?: boolean
  muted?: boolean
  customerNote?: string
  lastMessagePreview?: string
  /** 投放来源标识（广告 id 或追踪码） */
  leadSourceCode?: string
  /** ad = 平台广告上下文，code = 预填文案追踪码 */
  leadSourceVia?: string
  lastMessageAt: number
  /** 意向标签等级（会话列表附加，来自实时自动打标签）；未打标签则不带 */
  intentLevel?: 'high' | 'medium' | 'low' | 'unknown'
  /** 服务端会话快照版本，用于桌面端增量游标。 */
  syncUpdatedAt?: number
}

/** 客户端同步上来的消息（含译文，媒体以引用形式） */
export interface SyncMessage {
  externalId: string
  conversationId: string
  channel: string
  accountId: string
  direction: 'in' | 'out'
  authorName?: string
  bodyType: 'text' | 'media' | 'unsupported'
  text?: string
  mediaType?: string
  mediaId?: string
  mimeType?: string
  fileName?: string
  caption?: string
  durationSec?: number
  translationText?: string
  translationLang?: string
  timestamp: number
}

export interface SyncPayload {
  conversations: SyncConversation[]
  messages: SyncMessage[]
  /** 客户端账号实时资料；用于分享工单中的头像、联系方式和在线状态。 */
  accountProfiles?: SyncAccountProfile[]
}

export interface SyncAccountProfile {
  accountId: string
  channel: string
  handle?: string
  avatarMediaId?: string
  status?: 'online' | 'offline' | 'error' | 'removed'
}

export interface StoredMessage extends SyncMessage {
  /** 服务器最后写入该记录的时间；客户端用它做可靠的增量拉取游标。 */
  syncUpdatedAt: number
}
