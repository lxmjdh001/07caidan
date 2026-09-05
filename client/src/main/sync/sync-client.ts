import { parseConversationId, type ChannelKind, type Conversation, type MediaType, type UnifiedMessage } from '@shared/domain'
import type { SyncConfig } from '@shared/settings'
import type { Logger } from '../core/logger'
import { noopLogger } from '../core/logger'
import type { MessageStore } from '../core/message-store'
import type { MediaStore } from '../core/media-store'

export interface SyncAccountProfile {
  accountId: string
  channel: string
  handle?: string
  avatarMediaId?: string
  status?: 'online' | 'offline' | 'error'
}

const SYNC_INTERVAL_MS = 5_000
/** 单次批量上传的最大消息数 */
const BATCH_SIZE = 500
const PULL_BATCH_SIZE = 500

export interface SyncRecord {
  /** 已同步到的时间水位 */
  lastSyncedAt: number
  /**
   * 恰好在 lastSyncedAt 这一刻（同秒）已同步的 externalId。
   * WhatsApp 时间戳是秒级，同秒可能有多条消息，用它避免既漏传又重复传。
   */
  boundaryIds: string[]
  /** 服务端消息流游标；以服务端写入时间 + externalId 组成，跨设备不会漏同毫秒消息。 */
  remoteCursor?: { updatedAt: number; externalId: string }
  /** 服务端会话资料增量游标。 */
  conversationCursor?: { updatedAt: number; id: string }
  /** 已把服务端所有会话（包括暂无消息的群）回填到本机。 */
  remoteConversationsBootstrapped?: boolean
  /** 首次历史消息恢复已完成；之后的新入站增量才计未读。 */
  remoteMessagesBootstrapped?: boolean
  readCursor?: { updatedAt: number; conversationId: string }
  readAtByConversation?: Record<string, number>
  pendingReads?: Record<string, number>
  /** 本机修改但尚未成功提交主库的会话资料。 */
  dirtyConversationIds?: string[]
  /** 游标所属的后台账号；换后台/换客户账号时必须从零恢复。 */
  remoteScope?: string
}

interface RemoteConversation {
  id: string
  channel: string
  accountId: string
  contactId?: string
  publicId?: string
  avatarMediaId?: string
  title: string
  isGroup: boolean
  detectedLang?: string
  langOverride?: string | null
  autoReply?: boolean
  pinned?: boolean
  muted?: boolean
  customerNote?: string
  lastMessagePreview?: string
  leadSourceCode?: string
  leadSourceVia?: 'ad' | 'code'
  lastMessageAt: number
  syncUpdatedAt?: number
}

interface RemoteMessage {
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
  syncUpdatedAt: number
}

/**
 * 服务器主库同步引擎：先把服务端历史/增量回填为本地缓存，再把本机新消息批量推送回去。
 * 平台扫码凭证仍只存本机，聊天数据则以服务端为可恢复主库。
 */
export class SyncClient {
  private readonly store: MessageStore
  private readonly media: MediaStore | undefined
  private readonly getConfig: () => SyncConfig
  private readonly log: Logger
  private timer: ReturnType<typeof setInterval> | undefined
  private kickTimer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private record: SyncRecord = { lastSyncedAt: 0, boundaryIds: [] }
  private readonly persistRecord: (r: SyncRecord) => Promise<void>
  private pendingPersist: Promise<void> = Promise.resolve()
  private readonly getAccountProfiles: (() => Promise<SyncAccountProfile[]>) | undefined
  private readonly onRemoteMessage: ((message: UnifiedMessage, conversation: Conversation) => void) | undefined
  private readonly onRemoteConversation: ((conversation: Conversation) => void) | undefined

  constructor(opts: {
    store: MessageStore
    media?: MediaStore
    getConfig: () => SyncConfig
    initialRecord?: SyncRecord
    persistRecord: (r: SyncRecord) => Promise<void>
    getAccountProfiles?: () => Promise<SyncAccountProfile[]>
    /** 服务端历史写入本地缓存后，通知渲染层刷新；不触发桌面通知或自动回复。 */
    onRemoteMessage?: (message: UnifiedMessage, conversation: Conversation) => void
    onRemoteConversation?: (conversation: Conversation) => void
    logger?: Logger
  }) {
    this.store = opts.store
    this.media = opts.media
    this.getConfig = opts.getConfig
    this.persistRecord = opts.persistRecord
    this.getAccountProfiles = opts.getAccountProfiles
    this.onRemoteMessage = opts.onRemoteMessage
    this.onRemoteConversation = opts.onRemoteConversation
    if (opts.initialRecord) this.record = opts.initialRecord
    this.log = (opts.logger ?? noopLogger).child('sync')
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.runOnce(), SYNC_INTERVAL_MS)
    // 登录后尽快恢复另一台电脑的增量；定时器仍有可重入保护。
    setTimeout(() => void this.runOnce(), 1_000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.kickTimer) clearTimeout(this.kickTimer)
    this.kickTimer = undefined
  }

  /** 本地消息/资料刚变化时短防抖触发，不必等 5 秒轮询。 */
  requestSoon(): void {
    if (this.kickTimer) clearTimeout(this.kickTimer)
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined
      void this.runOnce()
    }, 350)
  }

  /** 立即执行一次同步（幂等，可重入保护） */
  async runOnce(): Promise<{ conversations: number; messages: number } | null> {
    const cfg = this.getConfig()
    if (!cfg.enabled || !cfg.serverUrl || !cfg.token) return null
    if (this.running) return null
    this.running = true
    try {
      this.ensureScope(cfg)
      await this.pushPendingReads(cfg)
      await this.pullReadMarkers(cfg)
      await this.pullFromServer(cfg)
      return await this.sync(cfg)
    } catch (err) {
      this.log.warn('同步失败，下个周期重试', { err: String(err) })
      return null
    } finally {
      this.running = false
    }
  }

  async markConversationDirty(conversationId: string): Promise<void> {
    const cfg = this.getConfig()
    if (cfg.serverUrl && cfg.token) this.ensureScope(cfg)
    this.record = {
      ...this.record,
      dirtyConversationIds: [...new Set([...(this.record.dirtyConversationIds ?? []), conversationId])]
    }
    await this.saveRecord()
    this.requestSoon()
  }

  /** 本机已读立即入待同步队列；断网时保留，恢复后自动补传。 */
  async markRead(conversationId: string): Promise<void> {
    const cfg = this.getConfig()
    if (cfg.serverUrl && cfg.token) this.ensureScope(cfg)
    const at = Date.now()
    this.record = {
      ...this.record,
      readAtByConversation: { ...(this.record.readAtByConversation ?? {}), [conversationId]: at },
      pendingReads: { ...(this.record.pendingReads ?? {}), [conversationId]: at }
    }
    await this.saveRecord()
    void this.runOnce()
  }

  /** 跨设备副作用去重。配置了主库时失败关闭，避免两台电脑同时自动回复。 */
  async claim(purpose: string, key: string): Promise<boolean> {
    const cfg = this.getConfig()
    if (!cfg.enabled || !cfg.serverUrl || !cfg.token) return true
    try {
      const result = await this.post(cfg, '/api/sync/claim', { purpose, key }) as { claimed?: boolean }
      return result.claimed === true
    } catch (error) {
      this.log.warn('多设备任务抢占失败，本次不执行', { purpose, error: String(error) })
      return false
    }
  }

  private async sync(cfg: SyncConfig): Promise<{ conversations: number; messages: number }> {
    const accountProfiles = this.getAccountProfiles ? await this.getAccountProfiles().catch(() => []) : []
    const conversations = await this.store.listConversations()
    const dirty = new Set(this.record.dirtyConversationIds ?? [])
    const dirtyConversations = conversations.filter((conversation) => dirty.has(conversation.id))
    await this.uploadReferencedMedia(cfg, [
      ...accountProfiles.map((profile) => profile.avatarMediaId),
      ...conversations.map((conversation) => conversation.avatarMediaId)
    ].filter((id): id is string => !!id))
    const since = this.record.lastSyncedAt
    const boundary = new Set(this.record.boundaryIds)
    const allNew: UnifiedMessage[] = []
    for (const conv of conversations) {
      // 服务器是主库时，首次接入不能因为 1000 条上限而漏掉早期本地历史。
      const msgs = await this.store.listMessages(conv.id, Number.MAX_SAFE_INTEGER)
      for (const m of msgs) {
        if (!m.externalId) continue
        // 严格晚于水位，或同秒但未在上次已传集合中
        if (m.timestamp > since || (m.timestamp === since && !boundary.has(m.externalId))) {
          allNew.push(m)
        }
      }
    }
    allNew.sort((a, b) => a.timestamp - b.timestamp)

    if (allNew.length === 0) {
      if (accountProfiles.length > 0 || dirtyConversations.length > 0) {
        await this.post(cfg, '/api/sync', {
          conversations: dirtyConversations.map(mapConversation),
          messages: [],
          accountProfiles
        })
        this.record = { ...this.record, dirtyConversationIds: [] }
        await this.saveRecord()
      }
      return { conversations: dirtyConversations.length, messages: 0 }
    }

    let synced = 0
    let maxTs = since
    for (let i = 0; i < allNew.length; i += BATCH_SIZE) {
      const batch = allNew.slice(i, i + BATCH_SIZE)
      const convIds = new Set(batch.map((m) => m.conversationId))
      // 消息所属会话必带；本机单独改过的备注/语言/置顶等也在首批带上。
      if (i === 0) for (const id of dirty) convIds.add(id)
      const convsForBatch = conversations.filter((c) => convIds.has(c.id))
      const payload = {
        conversations: convsForBatch.map(mapConversation),
        messages: batch.map(mapMessage),
        ...(i === 0 && accountProfiles.length > 0 ? { accountProfiles } : {})
      }
      await this.post(cfg, '/api/sync', payload)
      synced += batch.length
      for (const m of batch) maxTs = Math.max(maxTs, m.timestamp)

      if (cfg.uploadMedia && this.media) {
        await this.uploadMedia(cfg, batch)
      }
    }

    // 新水位 = maxTs；boundaryIds = 本次(及上次同秒)在 maxTs 的所有 externalId
    const newBoundary = allNew
      .filter((m) => m.timestamp === maxTs)
      .map((m) => m.externalId!)
    if (maxTs === since) for (const id of boundary) newBoundary.push(id)
    this.record = {
      ...this.record,
      lastSyncedAt: maxTs,
      boundaryIds: [...new Set(newBoundary)],
      dirtyConversationIds: []
    }
    await this.saveRecord()
    this.log.info('同步完成', { messages: synced })
    return { conversations: conversations.length, messages: synced }
  }

  private async uploadMedia(cfg: SyncConfig, batch: UnifiedMessage[]): Promise<void> {
    const mediaInfo = new Map<string, string>()
    for (const message of batch) {
      if (message.body.type === 'media' && message.body.mediaId) {
        mediaInfo.set(message.body.mediaId, message.body.mimeType || 'application/octet-stream')
      }
    }
    const mediaIds = [...mediaInfo.keys()]
    if (mediaIds.length === 0) return

    const { missing } = (await this.post(cfg, '/api/media/missing', { mediaIds })) as {
      missing: string[]
    }
    for (const mediaId of missing) {
      const path = this.media!.resolvePath(mediaId)
      if (!path) continue
      const buf = await readFile(path)
      const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${cfg.token}`,
          'content-type': mediaInfo.get(mediaId) || 'application/octet-stream'
        },
        body: new Uint8Array(buf),
        signal: AbortSignal.timeout(30_000)
      })
      if (!res.ok) throw new Error(`/api/media/${mediaId} HTTP ${res.status}`)
    }
  }

  /** 新设备（或换后台账号）首次登录时，恢复没有消息的会话、全部历史消息及其后的增量。 */
  private async pullFromServer(cfg: SyncConfig): Promise<void> {
    if (!this.record.remoteConversationsBootstrapped) {
      await this.bootstrapConversations(cfg)
      this.record = { ...this.record, remoteConversationsBootstrapped: true }
      await this.saveRecord()
    }
    await this.pullConversationUpdates(cfg)

    let cursor = this.record.remoteCursor
    for (;;) {
      const query = new URLSearchParams({
        after: String(cursor?.updatedAt ?? 0),
        afterId: cursor?.externalId ?? '',
        limit: String(PULL_BATCH_SIZE)
      })
      const page = (await this.get(cfg, `/api/sync/pull?${query}`)) as {
        messages?: RemoteMessage[]
        conversations?: RemoteConversation[]
        cursor?: { updatedAt: number; externalId: string } | null
      }
      const conversations = page.conversations ?? []
      for (const remote of conversations) await this.hydrateConversation(remote, cfg)
      const messages = page.messages ?? []
      const countUnread = this.record.remoteMessagesBootstrapped === true
      for (const remote of messages) await this.hydrateMessage(remote, cfg, countUnread)
      if (messages.length === 0 || !page.cursor) break
      cursor = page.cursor
      this.record = { ...this.record, remoteCursor: cursor }
      await this.saveRecord()
      if (messages.length < PULL_BATCH_SIZE) break
    }
    if (!this.record.remoteMessagesBootstrapped) {
      this.record = { ...this.record, remoteMessagesBootstrapped: true }
      await this.saveRecord()
    }
  }

  private ensureScope(cfg: SyncConfig): void {
    const scope = `${cfg.serverUrl.replace(/\/$/, '')}|${cfg.email}`
    if (this.record.remoteScope === scope) return
    // 本机缓存稍后会按账号目录重新协调；所有服务器游标必须立即归零，不能跨客户复用。
    this.record = {
      lastSyncedAt: 0,
      boundaryIds: [],
      remoteScope: scope,
      remoteCursor: undefined,
      conversationCursor: undefined,
      remoteConversationsBootstrapped: false,
      remoteMessagesBootstrapped: false,
      readCursor: undefined,
      readAtByConversation: {},
      pendingReads: {},
      dirtyConversationIds: []
    }
  }

  private async pullConversationUpdates(cfg: SyncConfig): Promise<void> {
    let cursor = this.record.conversationCursor
    for (;;) {
      const query = new URLSearchParams({
        after: String(cursor?.updatedAt ?? 0),
        afterId: cursor?.id ?? '',
        limit: String(PULL_BATCH_SIZE)
      })
      const page = await this.get(cfg, `/api/sync/conversations?${query}`) as {
        conversations?: RemoteConversation[]
        cursor?: { updatedAt: number; id: string } | null
      }
      const conversations = page.conversations ?? []
      for (const remote of conversations) await this.hydrateConversation(remote, cfg)
      if (!page.cursor || conversations.length === 0) break
      cursor = page.cursor
      this.record = { ...this.record, conversationCursor: cursor }
      await this.saveRecord()
      if (conversations.length < PULL_BATCH_SIZE) break
    }
  }

  private async bootstrapConversations(cfg: SyncConfig): Promise<void> {
    const limit = 250
    for (let offset = 0; ; offset += limit) {
      const page = (await this.get(cfg, `/api/conversations?limit=${limit}&offset=${offset}`)) as {
        conversations?: RemoteConversation[]
      }
      const conversations = page.conversations ?? []
      for (const remote of conversations) await this.hydrateConversation(remote, cfg)
      if (conversations.length < limit) return
    }
  }

  private async hydrateConversation(remote: RemoteConversation, cfg: SyncConfig): Promise<void> {
    const avatarMediaId = remote.avatarMediaId
      ? await this.downloadMedia(cfg, remote.avatarMediaId)
      : undefined
    const conversation = remoteToConversation(remote, avatarMediaId)
    if (!conversation) return
    const saved = await this.store.upsertConversation(conversation)
    this.onRemoteConversation?.(saved)
  }

  private async hydrateMessage(remote: RemoteMessage, cfg: SyncConfig, countUnread: boolean): Promise<void> {
    const mediaId = remote.bodyType === 'media' && remote.mediaId
      ? await this.downloadMedia(cfg, remote.mediaId)
      : undefined
    const message = remoteToMessage(remote, mediaId)
    if (!message) return
    const readAt = this.record.readAtByConversation?.[message.conversationId] ?? 0
    const result = await this.store.recordMessage(message, {
      incrementUnread: countUnread && message.direction === 'in' && message.timestamp > readAt
    })
    if (!result.duplicated) this.onRemoteMessage?.(message, result.conversation)
  }

  private async uploadReferencedMedia(cfg: SyncConfig, mediaIds: string[]): Promise<void> {
    if (!this.media || !cfg.uploadMedia) return
    if (mediaIds.length === 0) return
    const { missing } = (await this.post(cfg, '/api/media/missing', { mediaIds: [...new Set(mediaIds)] })) as { missing: string[] }
    for (const mediaId of missing) {
      const path = this.media.resolvePath(mediaId)
      if (!path) continue
      const buf = await readFile(path)
      const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'image/jpeg' },
        body: new Uint8Array(buf),
        signal: AbortSignal.timeout(30_000)
      })
      if (!res.ok) throw new Error(`/api/media/${mediaId} HTTP ${res.status}`)
    }
  }

  private async downloadMedia(cfg: SyncConfig, mediaId: string): Promise<string | undefined> {
    if (!this.media || !cfg.uploadMedia || !/^[\w.-]+$/.test(mediaId)) return undefined
    if (await this.media.has(mediaId)) return mediaId
    try {
      const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`, {
        headers: { authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(30_000)
      })
      if (!res.ok) return undefined
      await this.media.saveAs(mediaId, Buffer.from(await res.arrayBuffer()))
      return mediaId
    } catch (error) {
      this.log.debug('媒体恢复失败，保留占位', { mediaId, error: String(error) })
      return undefined
    }
  }

  private async pushPendingReads(cfg: SyncConfig): Promise<void> {
    const pending = { ...(this.record.pendingReads ?? {}) }
    let changed = false
    for (const conversationId of Object.keys(pending)) {
      try {
        const result = await this.put(cfg, `/api/conversations/${encodeURIComponent(conversationId)}/read`, {}) as {
          readAt?: number
        }
        if (typeof result.readAt === 'number') {
          this.record.readAtByConversation = {
            ...(this.record.readAtByConversation ?? {}),
            [conversationId]: result.readAt
          }
        }
        delete pending[conversationId]
        changed = true
      } catch {
        // 保留队列；其他会话仍继续尝试。
      }
    }
    if (changed) {
      this.record = { ...this.record, pendingReads: pending }
      await this.saveRecord()
    }
  }

  private async pullReadMarkers(cfg: SyncConfig): Promise<void> {
    let cursor = this.record.readCursor
    for (;;) {
      const query = new URLSearchParams({
        after: String(cursor?.updatedAt ?? 0),
        afterId: cursor?.conversationId ?? '',
        limit: String(PULL_BATCH_SIZE)
      })
      const page = await this.get(cfg, `/api/sync/reads?${query}`) as {
        reads?: Array<{ conversationId: string; readAt: number; updatedAt: number }>
        cursor?: { updatedAt: number; conversationId: string } | null
      }
      const reads = page.reads ?? []
      for (const marker of reads) {
        const previous = this.record.readAtByConversation?.[marker.conversationId] ?? 0
        if (marker.readAt <= previous) continue
        this.record.readAtByConversation = {
          ...(this.record.readAtByConversation ?? {}),
          [marker.conversationId]: marker.readAt
        }
        const messages = await this.store.listMessages(marker.conversationId, Number.MAX_SAFE_INTEGER)
        const latestInbound = messages.reduce(
          (latest, message) => message.direction === 'in' ? Math.max(latest, message.timestamp) : latest,
          0
        )
        if (latestInbound <= marker.readAt) {
          await this.store.markRead(marker.conversationId)
          const conversation = await this.store.getConversation(marker.conversationId)
          if (conversation) this.onRemoteConversation?.(conversation)
        }
      }
      if (!page.cursor || reads.length === 0) break
      cursor = page.cursor
      this.record = { ...this.record, readCursor: cursor }
      await this.saveRecord()
      if (reads.length < PULL_BATCH_SIZE) break
    }
  }

  private async saveRecord(): Promise<void> {
    const snapshot = structuredClone(this.record)
    const next = this.pendingPersist.then(() => this.persistRecord(snapshot))
    this.pendingPersist = next.catch(() => undefined)
    await next
  }

  private async post(cfg: SyncConfig, path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`)
    return res.json()
  }

  private async put(cfg: SyncConfig, path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}${path}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`)
    return res.json()
  }

  private async get(cfg: SyncConfig, path: string): Promise<unknown> {
    const res = await fetch(`${cfg.serverUrl.replace(/\/$/, '')}${path}`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`)
    return res.json()
  }
}

function remoteToConversation(remote: RemoteConversation, avatarMediaId?: string): Conversation | undefined {
  try {
    const parsed = parseConversationId(remote.id)
    if (!isChannelKind(remote.channel) || parsed.channel !== remote.channel || !remote.accountId) return undefined
    return {
      id: remote.id,
      channel: parsed.channel,
      accountId: remote.accountId,
      externalChatId: parsed.externalChatId,
      contactId: remote.contactId,
      publicId: remote.publicId,
      avatarMediaId,
      title: remote.title || parsed.externalChatId,
      isGroup: Boolean(remote.isGroup),
      detectedLang: remote.detectedLang,
      langOverride: remote.langOverride ?? undefined,
      autoReply: remote.autoReply === true,
      pinned: remote.pinned === true,
      muted: remote.muted === true,
      customerNote: remote.customerNote ?? '',
      leadSource: remote.leadSourceCode && (remote.leadSourceVia === 'ad' || remote.leadSourceVia === 'code')
        ? { code: remote.leadSourceCode, via: remote.leadSourceVia }
        : undefined,
      lastMessageAt: Number(remote.lastMessageAt) || 0,
      lastMessagePreview: remote.lastMessagePreview ?? '',
      unreadCount: 0
    }
  } catch {
    return undefined
  }
}

function remoteToMessage(remote: RemoteMessage, mediaId?: string): UnifiedMessage | undefined {
  if (!isChannelKind(remote.channel) || !remote.externalId || !remote.conversationId || !remote.accountId) return undefined
  const timestamp = Number(remote.timestamp)
  if (!Number.isFinite(timestamp) || timestamp < 0) return undefined
  const base = {
    // 服务端 externalId 在租户内唯一；用稳定的本地 id 防止重启后重复渲染。
    id: `server:${remote.externalId}`,
    externalId: remote.externalId,
    channel: remote.channel,
    accountId: remote.accountId,
    conversationId: remote.conversationId,
    direction: remote.direction === 'out' ? 'out' as const : 'in' as const,
    authorName: remote.authorName,
    timestamp,
    status: remote.direction === 'out' ? 'sent' as const : 'delivered' as const,
    translation: remote.translationText && remote.translationLang
      ? { text: remote.translationText, targetLang: remote.translationLang, engine: 'server' }
      : undefined
  }
  if (remote.bodyType === 'text') return { ...base, body: { type: 'text', text: remote.text ?? '' } }
  if (remote.bodyType === 'media') {
    return {
      ...base,
      body: {
        type: 'media',
        mediaType: isMediaType(remote.mediaType) ? remote.mediaType : 'document',
        mediaId,
        mimeType: remote.mimeType,
        fileName: remote.fileName,
        caption: remote.caption,
        durationSec: numberOrUndefined(remote.durationSec)
      }
    }
  }
  return { ...base, body: { type: 'unsupported', description: remote.text ?? '暂不支持的消息' } }
}

function isChannelKind(value: string): value is ChannelKind {
  return value === 'whatsapp' || value === 'telegram' || value === 'telegram_bot' ||
    value === 'line' || value === 'kakaotalk' || value === 'facebook' || value === 'instagram' ||
    value === 'tiktok' || value === 'x' || value === 'snapchat'
}

function isMediaType(value: unknown): value is MediaType {
  return value === 'image' || value === 'video' || value === 'audio' || value === 'document' || value === 'sticker'
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function mapConversation(c: Conversation): Record<string, unknown> {
  return {
    id: c.id,
    channel: c.channel,
    accountId: c.accountId,
    contactId: c.contactId,
    publicId: c.publicId,
    avatarMediaId: c.avatarMediaId,
    title: c.title,
    isGroup: c.isGroup,
    detectedLang: c.detectedLang,
    langOverride: c.langOverride ?? null,
    autoReply: c.autoReply === true,
    pinned: c.pinned === true,
    muted: c.muted === true,
    customerNote: c.customerNote ?? '',
    lastMessagePreview: c.lastMessagePreview,
    lastMessageAt: c.lastMessageAt,
    // 投放来源：后台按来源拆分工单统计要用；只传归因结果，不含任何客户信息
    leadSourceCode: c.leadSource?.code,
    leadSourceVia: c.leadSource?.via
  }
}

function mapMessage(m: UnifiedMessage): Record<string, unknown> {
  const base = {
    externalId: m.externalId,
    conversationId: m.conversationId,
    channel: m.channel,
    accountId: m.accountId,
    direction: m.direction,
    authorName: m.authorName,
    timestamp: m.timestamp,
    translationText: m.translation?.text,
    translationLang: m.translation?.targetLang
  }
  if (m.body.type === 'text') {
    return { ...base, bodyType: 'text', text: m.body.text }
  }
  if (m.body.type === 'media') {
    return {
      ...base,
      bodyType: 'media',
      mediaType: m.body.mediaType,
      mediaId: m.body.mediaId,
      mimeType: m.body.mimeType,
      fileName: m.body.fileName,
      caption: m.body.caption,
      durationSec: m.body.durationSec
    }
  }
  return { ...base, bodyType: 'unsupported', text: m.body.description }
}

// 延迟引入，避免核心层顶层依赖 node:fs（保持可测试）
async function readFile(path: string): Promise<Buffer> {
  const { readFile: rf } = await import('node:fs/promises')
  return rf(path)
}
