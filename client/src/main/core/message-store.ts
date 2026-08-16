import type { Conversation, UnifiedMessage } from '@shared/domain'

export interface RecordMessageOptions {
  /** 收到的入站消息才累计未读 */
  incrementUnread?: boolean
}

export interface RecordMessageResult {
  conversation: Conversation
  /** 按 externalId 判定为重复投递（如断线重连后的补发），未入库 */
  duplicated: boolean
}

/** 会话元信息 upsert 入参（消息之外的渠道事件，如联系人名） */
export interface ConversationPatch {
  id: string
  title?: string
  isGroup?: boolean
  avatarMediaId?: string
  contactId?: string
  detectedLang?: string
  /** 手动客户语言；null 表示清除（回到自动） */
  langOverride?: string | null
}

/**
 * 消息/会话存储接口。当前实现为 JSON 文件（零原生依赖），
 * 后续可无缝替换为 SQLite 实现。
 */
export interface MessageStore {
  init(): Promise<void>
  recordMessage(msg: UnifiedMessage, opts?: RecordMessageOptions): Promise<RecordMessageResult>
  /** 按内部 id 整体替换已存在的消息（媒体下载完成等场景）；不存在则忽略并返回 false */
  updateMessage(msg: UnifiedMessage): Promise<boolean>
  patchConversation(patch: ConversationPatch): Promise<Conversation | undefined>
  getConversation(id: string): Promise<Conversation | undefined>
  listConversations(): Promise<Conversation[]>
  listMessages(conversationId: string, limit?: number): Promise<UnifiedMessage[]>
  markRead(conversationId: string): Promise<void>
  /** 立即落盘 */
  flush(): Promise<void>
}
