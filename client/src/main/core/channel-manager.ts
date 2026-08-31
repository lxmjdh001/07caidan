import { randomUUID } from 'node:crypto'
import type { ChannelState, Conversation, UnifiedMessage } from '@shared/domain'
import { conversationId, parseConversationId } from '@shared/domain'
import type { OmniEvent, OutboundPreview } from '@shared/ipc'
import { basename } from 'node:path'
import type { TranslationPipeline } from '../translation/pipeline'
import type { ChannelAdapter, GroupSummary } from './channel-adapter'
import { detectLeadSource } from './lead-source'
import { noopLogger, type Logger } from './logger'
import type { JsonContactStore } from './contact-store'
import type { MediaStore } from './media-store'
import type { MessageStore } from './message-store'
import { mediaTypeFromMime, mimeFromPath } from './mime'

/**
 * 渠道管理器：持有所有适配器实例，把它们的事件汇入
 * 翻译管道 → 存储 → 推送给 UI 这条统一链路，并把 UI 的发送请求路由回对应适配器。
 */
export class ChannelManager {
  private readonly adapters = new Map<string, ChannelAdapter>()
  private readonly states = new Map<string, ChannelState>()
  /** 已尝试拉取头像的会话（避免重复请求，无论成败本次运行只试一次） */
  private readonly avatarAttempted = new Set<string>()
  /** 已尝试拉取账号自身头像的渠道（避免连接事件重复请求） */
  private readonly selfAvatarAttempted = new Set<string>()
  /** 已尝试解析标题的会话 */
  private readonly titleAttempted = new Set<string>()
  /** 已尝试解析客户标识的会话 */
  private readonly contactAttempted = new Set<string>()
  /** 被用户禁用的账号；禁用时丢弃迟到的渠道事件，避免重新接收消息 */
  private readonly disabledAccounts = new Set<string>()

  constructor(
    private readonly store: MessageStore,
    private readonly translation: TranslationPipeline,
    private readonly broadcast: (evt: OmniEvent) => void,
    private readonly logger: Logger = noopLogger,
    private readonly media?: MediaStore,
    private readonly contacts?: JsonContactStore
  ) {}

  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.key)) {
      throw new Error(`渠道已注册: ${adapter.key}`)
    }
    this.adapters.set(adapter.key, adapter)
    this.states.set(adapter.key, {
      kind: adapter.kind,
      accountId: adapter.accountId,
      status: 'stopped'
    })

    adapter.on('state', (state) => {
      // 适配器状态事件只描述连接状态；保留已获取的账号头像，避免 stop/reconnect 时闪回平台 Logo。
      const previous = this.states.get(adapter.key)
      const nextState = state.avatarMediaId || !previous?.avatarMediaId
        ? state
        : { ...state, avatarMediaId: previous.avatarMediaId }
      this.states.set(adapter.key, nextState)
      this.broadcast({ type: 'channel:state', state: nextState })
      // 连接就绪后为该渠道的历史会话补拉头像
      if (state.status === 'connected') {
        this.ensureSelfAvatar(adapter)
        void this.store.listConversations().then((list) => {
          for (const conv of list) {
            if (conv.channel === adapter.kind && conv.accountId === adapter.accountId) {
              this.ensureAvatar(conv)
              this.ensureTitle(conv)
              this.ensureContactId(conv)
            }
          }
        })
      }
    })

    adapter.on('message', (msg) => {
      if (this.disabledAccounts.has(adapter.key)) return
      void this.handleIncoming(msg)
    })

    adapter.on('messageUpdate', (msg) => {
      if (this.disabledAccounts.has(adapter.key)) return
      void this.store.updateMessage(msg).then((updated) => {
        if (updated) this.broadcast({ type: 'message:updated', message: msg })
      })
    })

    adapter.on('conversation', (upsert) => {
      if (this.disabledAccounts.has(adapter.key)) return
      const id = conversationId(adapter.kind, adapter.accountId, upsert.externalChatId)
      void this.store
        .patchConversation({ id, title: upsert.title, isGroup: upsert.isGroup })
        .then((conv) => {
          if (conv) this.broadcast({ type: 'conversation:updated', conversation: conv })
        })
    })
  }

  listChannels(): ChannelState[] {
    return [...this.states.values()]
  }

  /** 提交工单前强制重新读取账号自身头像，避免连接后的异步预取尚未完成。 */
  async refreshSelfProfile(key: string): Promise<ChannelState> {
    const adapter = this.requireAdapter(key)
    const current = this.states.get(key)
    if (!current) throw new Error(`渠道状态不存在：${key}`)
    if (!adapter.fetchSelfAvatar || current.status !== 'connected') return current

    const mediaId = await adapter.fetchSelfAvatar()
    if (this.adapters.get(key) !== adapter) return current
    // 适配器把“暂时拉取失败”和“平台确实没有头像”都表示为 undefined；
    // 已有头像时保留缓存，避免一次网络抖动把真实头像误删。新账号则自然保持无头像。
    if (!mediaId) return current
    const updated: ChannelState = { ...current, avatarMediaId: mediaId }
    this.states.set(key, updated)
    this.broadcast({ type: 'channel:state', state: updated })
    return updated
  }

  /** 注销账号：停止连接、解绑事件、从注册表移除并广播 */
  async unregister(key: string): Promise<void> {
    const adapter = this.adapters.get(key)
    if (!adapter) return
    try {
      await adapter.stop()
    } catch {
      // 停止失败也继续移除
    }
    adapter.removeAllListeners()
    this.adapters.delete(key)
    this.states.delete(key)
    this.selfAvatarAttempted.delete(key)
    this.disabledAccounts.delete(key)
    this.broadcast({ type: 'channel:removed', key })
  }

  async start(key: string): Promise<void> {
    if (this.disabledAccounts.has(key)) throw new Error('账号已禁用，请先启用接收消息')
    await this.requireAdapter(key).start()
  }

  /** 设置启动时的禁用状态；调用后再执行 startAll 即可跳过这些账号。 */
  setDisabled(key: string, disabled: boolean): void {
    if (disabled) this.disabledAccounts.add(key)
    else this.disabledAccounts.delete(key)
  }

  async setAccountEnabled(key: string, enabled: boolean): Promise<void> {
    const adapter = this.requireAdapter(key)
    if (enabled) {
      this.disabledAccounts.delete(key)
      await adapter.start()
    } else {
      this.disabledAccounts.add(key)
      await adapter.stop()
    }
  }

  async listGroups(key: string): Promise<Conversation[]> {
    const adapter = this.requireAdapter(key)
    if (!adapter.listGroups) throw new Error(`渠道 ${key} 暂不支持群组`)
    const groups = await adapter.listGroups()
    const separator = key.indexOf(':')
    const channel = key.slice(0, separator) as Conversation['channel']
    const accountId = key.slice(separator + 1)
    const result: Conversation[] = []
    for (const group of groups) {
      const id = conversationId(channel, accountId, group.externalChatId)
      const existing = await this.store.getConversation(id)
      const conversation = await this.store.upsertConversation(existing ?? {
        id,
        channel,
        accountId,
        externalChatId: group.externalChatId,
        title: group.title,
        isGroup: true,
        lastMessageAt: 0,
        lastMessagePreview: '',
        unreadCount: 0
      })
      result.push(conversation)
      this.broadcast({ type: 'conversation:updated', conversation })
    }
    return result
  }

  async createGroup(key: string, subject: string, participantIds: string[]): Promise<Conversation> {
    const adapter = this.requireAdapter(key)
    if (!adapter.createGroup) throw new Error(`渠道 ${key} 暂不支持创建群组`)
    const group: GroupSummary = await adapter.createGroup(subject, participantIds)
    const separator = key.indexOf(':')
    const channel = key.slice(0, separator) as Conversation['channel']
    const accountId = key.slice(separator + 1)
    const id = conversationId(channel, accountId, group.externalChatId)
    const conversation = await this.store.upsertConversation({
      id,
      channel,
      accountId,
      externalChatId: group.externalChatId,
      title: group.title,
      isGroup: true,
      lastMessageAt: 0,
      lastMessagePreview: '',
      unreadCount: 0
    })
    this.broadcast({ type: 'conversation:updated', conversation })
    return conversation
  }

  async startAll(): Promise<void> {
    await Promise.allSettled(
      [...this.adapters.values()]
        .filter((adapter) => !this.disabledAccounts.has(adapter.key))
        .map((adapter) => adapter.start())
    )
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((a) => a.stop()))
  }

  async logout(key: string): Promise<void> {
    await this.requireAdapter(key).logout()
  }

  /** 切换某账号的登录方式（扫码 / 手机号），适配器会重启登录流程 */
  async setLoginMode(key: string, mode: string): Promise<void> {
    const adapter = this.requireAdapter(key)
    if (!adapter.setLoginMode) throw new Error(`渠道 ${key} 不支持切换登录方式`)
    await adapter.setLoginMode(mode)
  }

  /** 提交交互式登录输入（手机号/验证码/两步密码），仅 phone_code 类平台支持 */
  async submitAuthInput(key: string, value: string): Promise<void> {
    const adapter = this.requireAdapter(key)
    if (!adapter.submitAuthInput) throw new Error(`渠道 ${key} 不支持交互式登录`)
    await adapter.submitAuthInput(value)
  }

  /**
   * 出站目标语言解析，优先级：
   * 会话手动设置 > 自动检测 > 账号默认 > 全局默认
   */
  async resolveTargetLang(convId: string): Promise<string> {
    const conv = await this.store.getConversation(convId)
    if (conv?.langOverride) return conv.langOverride
    if (conv?.detectedLang) return conv.detectedLang
    const { channel, accountId } = parseConversationId(convId)
    const fallback = this.getLangDefaults?.(`${channel}:${accountId}`)
    return fallback?.accountDefault || fallback?.globalDefault || 'en'
  }

  /** 由装配层注入：读取账号级/全局默认客户语言 */
  getLangDefaults?: (channelKey: string) => { accountDefault?: string; globalDefault: string }

  /** 出站翻译预览：完成翻译但不发送（预览确认交互用） */
  async previewOutbound(convId: string, text: string): Promise<OutboundPreview> {
    const targetLang = await this.resolveTargetLang(convId)
    const outbound = await this.translation.processOutbound(text, targetLang)
    return { ...outbound, targetLang }
  }

  /**
   * UI 发送文本：翻译成客户语言（可关）→ 适配器发出 → 入库 → 回推 UI。
   * prepared 传入预览结果时直接采用，不重复翻译。
   */
  async sendText(
    convId: string,
    text: string,
    prepared?: OutboundPreview,
    origin?: 'agent' | 'autoreply'
  ): Promise<UnifiedMessage> {
    const { channel, accountId, externalChatId } = parseConversationId(convId)
    const adapter = this.requireAdapter(`${channel}:${accountId}`)
    if (this.disabledAccounts.has(adapter.key)) throw new Error('账号已禁用，无法发送消息')

    const targetLang = prepared?.targetLang ?? (await this.resolveTargetLang(convId))
    const outbound = prepared ?? (await this.translation.processOutbound(text, targetLang))
    if (outbound.error) throw new Error(outbound.error)

    const msg: UnifiedMessage = {
      id: randomUUID(),
      channel,
      accountId,
      conversationId: convId,
      direction: 'out',
      body: { type: 'text', text: outbound.send },
      // 发生了翻译时，把坐席原文挂在 translation 字段供 UI 双显
      translation:
        outbound.engine !== undefined
          ? { text: outbound.original, targetLang, engine: outbound.engine }
          : undefined,
      origin,
      timestamp: Date.now(),
      status: 'pending'
    }

    try {
      const result = await adapter.sendText(externalChatId, outbound.send)
      msg.status = 'sent'
      msg.externalId = result.externalId
    } catch (err) {
      msg.status = 'failed'
      this.logger.error(`[${adapter.key}] 发送失败`, err)
    }

    const { conversation } = await this.store.recordMessage(msg)
    this.broadcast({ type: 'message:new', message: msg, conversation })
    return msg
  }

  /**
   * 发送录制的语音条。
   * 数据来自渲染进程的 MediaRecorder（webm/opus），先落进 MediaStore 再发。
   */
  async sendVoice(
    convId: string,
    data: Uint8Array,
    mimeType: string,
    durationSec: number
  ): Promise<UnifiedMessage> {
    if (!this.media) throw new Error('MediaStore 未配置')
    const { channel, accountId, externalChatId } = parseConversationId(convId)
    const adapter = this.requireAdapter(`${channel}:${accountId}`)
    if (this.disabledAccounts.has(adapter.key)) throw new Error('账号已禁用，无法发送消息')
    if (!adapter.sendMedia) throw new Error(`渠道 ${adapter.key} 暂不支持发送媒体`)

    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm'
    const mediaId = await this.media.save(Buffer.from(data), ext)
    const localPath = this.media.resolvePath(mediaId)!
    const seconds = Math.max(1, Math.round(durationSec))

    const msg: UnifiedMessage = {
      id: randomUUID(),
      channel,
      accountId,
      conversationId: convId,
      direction: 'out',
      body: {
        type: 'media',
        mediaType: 'audio',
        mediaId,
        mimeType,
        fileName: `voice.${ext}`,
        durationSec: seconds
      },
      timestamp: Date.now(),
      status: 'pending'
    }

    try {
      const result = await adapter.sendMedia(externalChatId, {
        filePath: localPath,
        mediaType: 'audio',
        mimeType,
        fileName: `voice.${ext}`,
        ptt: true,
        durationSec: seconds
      })
      msg.status = 'sent'
      msg.externalId = result.externalId
    } catch (err) {
      msg.status = 'failed'
      this.logger.error(`[${adapter.key}] 语音发送失败`, err)
    }

    const { conversation } = await this.store.recordMessage(msg)
    this.broadcast({ type: 'message:new', message: msg, conversation })
    return msg
  }

  /** UI 发送本地文件：复制进 MediaStore → 适配器发出 → 入库 → 回推 UI */
  async sendMediaFile(convId: string, filePath: string): Promise<UnifiedMessage> {
    if (!this.media) throw new Error('MediaStore 未配置')
    const { channel, accountId, externalChatId } = parseConversationId(convId)
    const adapter = this.requireAdapter(`${channel}:${accountId}`)
    if (this.disabledAccounts.has(adapter.key)) throw new Error('账号已禁用，无法发送消息')
    if (!adapter.sendMedia) throw new Error(`渠道 ${adapter.key} 暂不支持发送媒体`)

    const mimeType = mimeFromPath(filePath)
    const mediaType = mediaTypeFromMime(mimeType)
    const fileName = basename(filePath)
    const mediaId = await this.media.importFile(filePath)
    const localPath = this.media.resolvePath(mediaId)!

    const msg: UnifiedMessage = {
      id: randomUUID(),
      channel,
      accountId,
      conversationId: convId,
      direction: 'out',
      body: { type: 'media', mediaType, mediaId, mimeType, fileName },
      timestamp: Date.now(),
      status: 'pending'
    }

    try {
      const result = await adapter.sendMedia(externalChatId, {
        filePath: localPath,
        mediaType,
        mimeType,
        fileName
      })
      msg.status = 'sent'
      msg.externalId = result.externalId
    } catch (err) {
      msg.status = 'failed'
      this.logger.error(`[${adapter.key}] 媒体发送失败`, err)
    }

    const { conversation } = await this.store.recordMessage(msg)
    this.broadcast({ type: 'message:new', message: msg, conversation })
    this.ensureAvatar(conversation)
    this.ensureTitle(conversation)
    this.ensureContactId(conversation)
    return msg
  }

  private async handleIncoming(raw: UnifiedMessage): Promise<void> {
    if (this.disabledAccounts.has(`${raw.channel}:${raw.accountId}`)) return
    try {
      const { message: msg, detectedLang } = await this.translation.processInbound(raw)
      if (this.disabledAccounts.has(`${raw.channel}:${raw.accountId}`)) return
      const { conversation, duplicated } = await this.store.recordMessage(msg, {
        incrementUnread: msg.direction === 'in'
      })
      if (duplicated) return
      this.broadcast({ type: 'message:new', message: msg, conversation })
      // 客户语言自动检测：只依据客户的来信（自己发的不算）
      if (
        msg.direction === 'in' &&
        detectedLang &&
        conversation.detectedLang !== detectedLang
      ) {
        const updated = await this.store.patchConversation({ id: conversation.id, detectedLang })
        if (updated) this.broadcast({ type: 'conversation:updated', conversation: updated })
      }
      // 投放归因：只认第一次，之后不再覆盖（同一个客户的来源不该变来变去）
      if (msg.direction === 'in' && !conversation.leadSource) {
        const source = msg.leadSource ?? detectLeadSource(textOf(msg))
        if (source) {
          const updated = await this.store.patchConversation({
            id: conversation.id,
            leadSource: source
          })
          if (updated) this.broadcast({ type: 'conversation:updated', conversation: updated })
        }
      }
      this.ensureAvatar(conversation)
      this.ensureTitle(conversation)
      this.ensureContactId(conversation)
    } catch (err) {
      this.logger.error('入站消息处理失败', err)
    }
  }

  /** 会话还没有头像时异步拉取一次（成功后广播 conversation:updated） */
  private ensureAvatar(conv: { id: string; avatarMediaId?: string }): void {
    if (conv.avatarMediaId || this.avatarAttempted.has(conv.id)) return
    this.avatarAttempted.add(conv.id)
    void (async () => {
      const { channel, accountId, externalChatId } = parseConversationId(conv.id)
      const adapter = this.adapters.get(`${channel}:${accountId}`)
      if (!adapter?.fetchAvatar) return
      try {
        const mediaId = await adapter.fetchAvatar(externalChatId)
        if (!mediaId) return
        const updated = await this.store.patchConversation({ id: conv.id, avatarMediaId: mediaId })
        if (updated) this.broadcast({ type: 'conversation:updated', conversation: updated })
      } catch (err) {
        this.logger.debug(`拉取头像失败 ${conv.id}`, err)
      }
    })()
  }

  /** 账号连接后异步拉取自身头像，成功后写回渠道状态并广播给 UI。 */
  private ensureSelfAvatar(adapter: ChannelAdapter): void {
    if (this.selfAvatarAttempted.has(adapter.key)) return
    if (!adapter.fetchSelfAvatar) return
    this.selfAvatarAttempted.add(adapter.key)
    void (async () => {
      try {
        const mediaId = await adapter.fetchSelfAvatar!()
        if (!mediaId) return
        if (this.adapters.get(adapter.key) !== adapter) return
        const current = this.states.get(adapter.key)
        if (!current) return
        const updated = { ...current, avatarMediaId: mediaId }
        this.states.set(adapter.key, updated)
        this.broadcast({ type: 'channel:state', state: updated })
      } catch (err) {
        this.logger.debug(`拉取账号头像失败 ${adapter.key}`, err)
      }
    })()
  }

  /** 标题仍是原始平台 ID 时，让适配器解析一次真实显示名（群名/备注） */
  private ensureTitle(conv: { id: string; title: string; externalChatId: string }): void {
    if (conv.title !== conv.externalChatId || this.titleAttempted.has(conv.id)) return
    this.titleAttempted.add(conv.id)
    void (async () => {
      const { channel, accountId, externalChatId } = parseConversationId(conv.id)
      const adapter = this.adapters.get(`${channel}:${accountId}`)
      if (!adapter?.fetchTitle) return
      try {
        const title = await adapter.fetchTitle(externalChatId)
        if (!title) return
        const updated = await this.store.patchConversation({ id: conv.id, title })
        if (updated) this.broadcast({ type: 'conversation:updated', conversation: updated })
      } catch (err) {
        this.logger.debug(`解析会话标题失败 ${conv.id}`, err)
      }
    })()
  }

  /**
   * 解析并登记客户的规范标识。已解析过的会话也会在每次运行首次触达时
   * 重新登记一次（更新 lastSeenAt 与名称历史）。
   */
  private ensureContactId(conv: {
    id: string
    title: string
    contactId?: string
  }): void {
    if (this.contactAttempted.has(conv.id)) return
    this.contactAttempted.add(conv.id)
    void (async () => {
      try {
        let contactId = conv.contactId
        if (!contactId) {
          const { channel, accountId, externalChatId } = parseConversationId(conv.id)
          const adapter = this.adapters.get(`${channel}:${accountId}`)
          if (!adapter?.resolveContactId) return
          contactId = await adapter.resolveContactId(externalChatId)
          if (!contactId) return
          const updated = await this.store.patchConversation({ id: conv.id, contactId })
          if (updated) this.broadcast({ type: 'conversation:updated', conversation: updated })
        }
        if (this.contacts) {
          const { otherConversations } = await this.contacts.record(contactId, conv.id, conv.title)
          if (otherConversations.length > 0) {
            this.logger.info(`识别到老客户 ${contactId}，此前会话:`, otherConversations)
          }
        }
      } catch (err) {
        this.logger.debug(`解析客户标识失败 ${conv.id}`, err)
      }
    })()
  }

  private requireAdapter(key: string): ChannelAdapter {
    const adapter = this.adapters.get(key)
    if (!adapter) throw new Error(`未注册的渠道: ${key}`)
    return adapter
  }
}

/** 取消息的可读文本（媒体取说明文字），用于解析预填文案里的追踪码 */
function textOf(msg: UnifiedMessage): string | undefined {
  const b = msg.body
  if (b.type === 'text') return b.text
  if (b.type === 'media') return b.caption
  return undefined
}
