import type { Conversation, LeadSourceInfo, UnifiedMessage } from '@shared/domain'

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
  /** 投放来源，首条入站消息识别后写入，之后不再变更 */
  leadSource?: LeadSourceInfo
  /** 会话级 AI 自动回复开关 */
  autoReply?: boolean
  /** 是否置顶显示在会话列表顶部 */
  pinned?: boolean
  muted?: boolean
  customerNote?: string
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
  /** 登记没有消息的新会话（例如新建群组后立即显示）。 */
  upsertConversation(conversation: Conversation): Promise<Conversation>
  getConversation(id: string): Promise<Conversation | undefined>
  listConversations(): Promise<Conversation[]>
  listMessages(conversationId: string, limit?: number): Promise<UnifiedMessage[]>
  markRead(conversationId: string): Promise<void>
  clearConversation(conversationId: string): Promise<void>
  deleteConversation(conversationId: string): Promise<void>
  inheritAccountConversations(sourceAccountKey: string, targetAccountKey: string): Promise<{ conversations: number; messages: number }>
  /** 立即落盘 */
  flush(): Promise<void>
}
