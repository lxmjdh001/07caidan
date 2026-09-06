import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Conversation, UnifiedMessage } from '@shared/domain'
import { previewOf } from '@shared/domain'
import type {
  ConversationPatch,
  MessageStore,
  RecordMessageOptions,
  RecordMessageResult
} from './message-store'

interface StoreData {
  version: 1
  conversations: Record<string, Conversation>
  messages: Record<string, UnifiedMessage[]>
}

const FLUSH_DELAY_MS = 500
/** 去重时向前回溯的消息条数 */
const DEDUPE_WINDOW = 200

/**
 * 基于单 JSON 文件的存储实现：内存内操作 + 防抖异步落盘（临时文件原子替换）。
 * 无原生依赖，跨平台零编译。消息量大后可替换为 SQLite 实现（接口不变）。
 */
export class JsonMessageStore implements MessageStore {
  private readonly filePath: string
  private data: StoreData = { version: 1, conversations: {}, messages: {} }
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private pendingFlush: Promise<void> = Promise.resolve()

  constructor(dir: string) {
    this.filePath = join(dir, 'store.json')
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as StoreData
      if (parsed.version === 1) this.data = parsed
    } catch {
      // 文件不存在或损坏：从空库开始（损坏时不覆盖旧文件，直到下一次写入）
    }
  }

  async recordMessage(
    msg: UnifiedMessage,
    opts: RecordMessageOptions = {}
  ): Promise<RecordMessageResult> {
    const list = (this.data.messages[msg.conversationId] ??= [])

    if (await this.hasMessage(msg)) {
      return { conversation: this.ensureConversation(msg), duplicated: true }
    }

    list.push(msg)
    const conv = this.ensureConversation(msg)
    if (msg.timestamp >= conv.lastMessageAt) {
      conv.lastMessageAt = msg.timestamp
      conv.lastMessagePreview = previewOf(msg.body)
    }
    if (opts.incrementUnread) conv.unreadCount += 1
    this.scheduleFlush()
    return { conversation: conv, duplicated: false }
  }

  async hasMessage(msg: Pick<UnifiedMessage, 'conversationId' | 'externalId' | 'id'>): Promise<boolean> {
    const list = this.data.messages[msg.conversationId] ?? []
    const start = Math.max(0, list.length - DEDUPE_WINDOW)
    for (let i = list.length - 1; i >= start; i--) {
      const existing = list[i]!
      if (msg.externalId ? existing.externalId === msg.externalId : existing.id === msg.id) return true
    }
    return false
  }

  async updateMessage(msg: UnifiedMessage): Promise<boolean> {
    const list = this.data.messages[msg.conversationId]
    if (!list) return false
    const idx = list.findIndex((m) => m.id === msg.id)
    if (idx < 0) return false
    list[idx] = msg
    this.scheduleFlush()
    return true
  }

  async patchConversation(patch: ConversationPatch): Promise<Conversation | undefined> {
    const conv = this.data.conversations[patch.id]
    if (!conv) return undefined
    if (patch.title) conv.title = patch.title
    if (patch.isGroup !== undefined) conv.isGroup = patch.isGroup
    if (patch.avatarMediaId) conv.avatarMediaId = patch.avatarMediaId
    if (patch.contactId) conv.contactId = patch.contactId
    if (patch.publicId) conv.publicId = patch.publicId
    if (patch.detectedLang) conv.detectedLang = patch.detectedLang
    if (patch.langOverride !== undefined) {
      conv.langOverride = patch.langOverride ?? undefined
    }
    // 这两个字段曾被漏掉：leadSource 使 Click-to-WhatsApp/[ref] 投放归因无法落库，
    // autoReply 使会话级 AI 自动回复开关点了不生效
    if (patch.leadSource) conv.leadSource = patch.leadSource
    if (patch.autoReply !== undefined) conv.autoReply = patch.autoReply
    if (patch.pinned !== undefined) conv.pinned = patch.pinned
    if (patch.muted !== undefined) conv.muted = patch.muted
    if (patch.customerNote !== undefined) conv.customerNote = patch.customerNote
    const snapshotIsCurrent = patch.lastMessageAt === undefined || patch.lastMessageAt >= conv.lastMessageAt
    if (patch.lastMessageAt !== undefined && snapshotIsCurrent) {
      conv.lastMessageAt = patch.lastMessageAt
      if (patch.lastMessagePreview !== undefined) conv.lastMessagePreview = patch.lastMessagePreview
    }
    if (patch.unreadCount !== undefined && snapshotIsCurrent) {
      conv.unreadCount = Math.max(0, patch.unreadCount)
    }
    this.scheduleFlush()
    return conv
  }

  async upsertConversation(conversation: Conversation): Promise<Conversation> {
    const existing = this.data.conversations[conversation.id]
    if (existing) {
      existing.title = conversation.title || existing.title
      existing.isGroup = conversation.isGroup
      existing.externalChatId = conversation.externalChatId
      existing.contactId = conversation.contactId ?? existing.contactId
      existing.publicId = conversation.publicId ?? existing.publicId
      existing.avatarMediaId = conversation.avatarMediaId ?? existing.avatarMediaId
      existing.detectedLang = conversation.detectedLang ?? existing.detectedLang
      existing.langOverride = conversation.langOverride
      existing.leadSource = conversation.leadSource ?? existing.leadSource
      existing.autoReply = conversation.autoReply
      existing.pinned = conversation.pinned
      existing.muted = conversation.muted
      existing.customerNote = conversation.customerNote ?? existing.customerNote
      if (conversation.lastMessageAt >= existing.lastMessageAt) {
        existing.lastMessageAt = conversation.lastMessageAt
        existing.lastMessagePreview = conversation.lastMessagePreview
      }
      this.scheduleFlush()
      return existing
    }
    this.data.conversations[conversation.id] = conversation
    this.data.messages[conversation.id] ??= []
    this.scheduleFlush()
    return conversation
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    return this.data.conversations[id]
  }

  async listConversations(): Promise<Conversation[]> {
    return Object.values(this.data.conversations).sort((a, b) => {
      const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      return pinnedDelta || b.lastMessageAt - a.lastMessageAt
    })
  }

  async listMessages(conversationId: string, limit = 200): Promise<UnifiedMessage[]> {
    const list = this.data.messages[conversationId] ?? []
    return list.slice(-limit)
  }

  async markRead(conversationId: string): Promise<void> {
    const conv = this.data.conversations[conversationId]
    if (conv && conv.unreadCount !== 0) {
      conv.unreadCount = 0
      this.scheduleFlush()
    }
  }

  async clearConversation(conversationId: string): Promise<void> {
    const conv = this.data.conversations[conversationId]
    if (!conv) return
    this.data.messages[conversationId] = []
    conv.unreadCount = 0
    conv.lastMessageAt = 0
    conv.lastMessagePreview = ''
    this.scheduleFlush()
  }

  async deleteConversation(conversationId: string): Promise<void> {
    delete this.data.conversations[conversationId]
    delete this.data.messages[conversationId]
    this.scheduleFlush()
  }

  async inheritAccountConversations(sourceAccountKey: string, targetAccountKey: string): Promise<{ conversations: number; messages: number }> {
    const sourceSep = sourceAccountKey.indexOf(':')
    const targetSep = targetAccountKey.indexOf(':')
    if (sourceSep <= 0 || targetSep <= 0) throw new Error('账号标识无效')
    const sourceChannel = sourceAccountKey.slice(0, sourceSep)
    const sourceAccount = sourceAccountKey.slice(sourceSep + 1)
    const targetChannel = targetAccountKey.slice(0, targetSep)
    const targetAccount = targetAccountKey.slice(targetSep + 1)
    if (sourceChannel !== targetChannel) throw new Error('只能在相同平台账号之间继承客户')
    if (sourceAccountKey === targetAccountKey) throw new Error('来源账号和目标账号不能相同')

    let conversationCount = 0
    let messageCount = 0
    for (const source of Object.values(this.data.conversations)) {
      if (source.channel !== sourceChannel || source.accountId !== sourceAccount) continue
      const targetId = `${targetChannel}:${targetAccount}:${source.externalChatId}`
      const target = this.data.conversations[targetId]
      if (target) {
        if (!target.title || target.title === target.externalChatId || /^\+\d+$/.test(target.title)) {
          target.title = source.title
        }
        target.contactId ??= source.contactId
        target.avatarMediaId ??= source.avatarMediaId
        target.detectedLang ??= source.detectedLang
        target.langOverride ??= source.langOverride
        target.leadSource ??= source.leadSource
        target.customerNote ??= source.customerNote
        if (source.lastMessageAt >= target.lastMessageAt) {
          target.lastMessageAt = source.lastMessageAt
          target.lastMessagePreview = source.lastMessagePreview
        }
      } else {
        this.data.conversations[targetId] = {
          ...source,
          id: targetId,
          accountId: targetAccount,
          pinned: false,
          unreadCount: 0
        }
        conversationCount += 1
      }
      const sourceMessages = this.data.messages[source.id] ?? []
      const targetMessages = (this.data.messages[targetId] ??= [])
      const knownExternal = new Set(targetMessages.map((m) => m.externalId).filter(Boolean))
      for (const message of sourceMessages) {
        if (message.externalId && knownExternal.has(message.externalId)) continue
        if (!message.externalId && targetMessages.some((m) => m.id === message.id)) continue
        targetMessages.push({
          ...message,
          id: randomUUID(),
          conversationId: targetId,
          accountId: targetAccount,
          channel: targetChannel as typeof message.channel
        })
        if (message.externalId) knownExternal.add(message.externalId)
        messageCount += 1
      }
    }
    if (conversationCount > 0 || messageCount > 0) this.scheduleFlush()
    return { conversations: conversationCount, messages: messageCount }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    await this.enqueueFlush()
  }

  private ensureConversation(msg: UnifiedMessage): Conversation {
    let conv = this.data.conversations[msg.conversationId]
    if (!conv) {
      const externalChatId = msg.conversationId.split(':').slice(2).join(':')
      conv = {
        id: msg.conversationId,
        channel: msg.channel,
        accountId: msg.accountId,
        externalChatId,
        // 标题先用能拿到的最好信息，后续由 patchConversation 用联系人名修正
        title: msg.direction === 'in' && msg.authorName ? msg.authorName : externalChatId,
        isGroup: false,
        lastMessageAt: msg.timestamp,
        lastMessagePreview: previewOf(msg.body),
        unreadCount: 0
      }
      this.data.conversations[msg.conversationId] = conv
    } else if (
      msg.direction === 'in' &&
      msg.authorName &&
      !conv.isGroup &&
      // 标题还是占位（原始平台 ID 或 "+手机号"）时，用发信人昵称升级
      (conv.title === conv.externalChatId || /^\+\d+$/.test(conv.title))
    ) {
      conv.title = msg.authorName
    }
    return conv
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.enqueueFlush()
    }, FLUSH_DELAY_MS)
  }

  /**
   * 所有原子替换写入共用一条串行队列。定时落盘和应用退出时的显式 flush 可能同时触发；
   * 若它们并发使用同一个 .tmp 文件，先完成的 rename 会让另一条写入报 ENOENT。
   */
  private enqueueFlush(): Promise<void> {
    const next = this.pendingFlush.then(() => this.writeToDisk())
    // 队列尾吞掉本次失败，确保一次磁盘错误不会让后续保存永久失效；
    // 返回的 next 仍保留拒绝，显式 flush 的调用方可以获知错误。
    this.pendingFlush = next.catch(() => undefined)
    return next
  }

  private async writeToDisk(): Promise<void> {
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(this.data), 'utf8')
    await rename(tmp, this.filePath)
  }
}
