import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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

    if (msg.externalId) {
      const start = Math.max(0, list.length - DEDUPE_WINDOW)
      for (let i = list.length - 1; i >= start; i--) {
        if (list[i]!.externalId === msg.externalId) {
          return { conversation: this.ensureConversation(msg), duplicated: true }
        }
      }
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
    if (patch.detectedLang) conv.detectedLang = patch.detectedLang
    if (patch.langOverride !== undefined) {
      conv.langOverride = patch.langOverride ?? undefined
    }
    this.scheduleFlush()
    return conv
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    return this.data.conversations[id]
  }

  async listConversations(): Promise<Conversation[]> {
    return Object.values(this.data.conversations).sort((a, b) => b.lastMessageAt - a.lastMessageAt)
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

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    await this.writeToDisk()
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
      this.pendingFlush = this.pendingFlush.then(() => this.writeToDisk())
    }, FLUSH_DELAY_MS)
  }

  private async writeToDisk(): Promise<void> {
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(this.data), 'utf8')
    await rename(tmp, this.filePath)
  }
}
