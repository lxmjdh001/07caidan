/** 客户端同步上来的会话（与桌面端 domain 对齐的子集） */
export interface SyncConversation {
  id: string
  channel: string
  accountId: string
  contactId?: string
  title: string
  isGroup: boolean
  /** 投放来源标识（广告 id 或追踪码） */
  leadSourceCode?: string
  /** ad = 平台广告上下文，code = 预填文案追踪码 */
  leadSourceVia?: string
  lastMessageAt: number
  /** 意向标签等级（会话列表附加，来自实时自动打标签）；未打标签则不带 */
  intentLevel?: 'high' | 'medium' | 'low' | 'unknown'
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

export interface StoredMessage extends SyncMessage {}
