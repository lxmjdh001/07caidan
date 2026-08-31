import type { Conversation, UnifiedMessage } from '@shared/domain'
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

const SYNC_INTERVAL_MS = 60_000
/** 单次批量上传的最大消息数 */
const BATCH_SIZE = 500

interface SyncRecord {
  /** 已同步到的时间水位 */
  lastSyncedAt: number
  /**
   * 恰好在 lastSyncedAt 这一刻（同秒）已同步的 externalId。
   * WhatsApp 时间戳是秒级，同秒可能有多条消息，用它避免既漏传又重复传。
   */
  boundaryIds: string[]
}

/**
 * 客户端批量定时同步引擎：周期性把本地会话/消息（含译文、可选媒体）增量推送到后台。
 * 幂等由服务端按 externalId 保证，这里只做"取增量 → 批量 POST → 推进水位"。
 */
export class SyncClient {
  private readonly store: MessageStore
  private readonly media: MediaStore | undefined
  private readonly getConfig: () => SyncConfig
  private readonly log: Logger
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  private record: SyncRecord = { lastSyncedAt: 0, boundaryIds: [] }
  private readonly persistRecord: (r: SyncRecord) => Promise<void>
  private readonly getAccountProfiles: (() => Promise<SyncAccountProfile[]>) | undefined

  constructor(opts: {
    store: MessageStore
    media?: MediaStore
    getConfig: () => SyncConfig
    initialRecord?: SyncRecord
    persistRecord: (r: SyncRecord) => Promise<void>
    getAccountProfiles?: () => Promise<SyncAccountProfile[]>
    logger?: Logger
  }) {
    this.store = opts.store
    this.media = opts.media
    this.getConfig = opts.getConfig
    this.persistRecord = opts.persistRecord
    this.getAccountProfiles = opts.getAccountProfiles
    if (opts.initialRecord) this.record = opts.initialRecord
    this.log = (opts.logger ?? noopLogger).child('sync')
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.runOnce(), SYNC_INTERVAL_MS)
    // 启动后延迟首次同步，避开冷启动高峰
    setTimeout(() => void this.runOnce(), 10_000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 立即执行一次同步（幂等，可重入保护） */
  async runOnce(): Promise<{ conversations: number; messages: number } | null> {
    const cfg = this.getConfig()
    if (!cfg.enabled || !cfg.serverUrl || !cfg.token) return null
    if (this.running) return null
    this.running = true
    try {
      return await this.sync(cfg)
    } catch (err) {
      this.log.warn('同步失败，下个周期重试', { err: String(err) })
      return null
    } finally {
      this.running = false
    }
  }

  private async sync(cfg: SyncConfig): Promise<{ conversations: number; messages: number }> {
    const accountProfiles = this.getAccountProfiles ? await this.getAccountProfiles().catch(() => []) : []
    await this.uploadProfileMedia(cfg, accountProfiles)
    const conversations = await this.store.listConversations()
    const since = this.record.lastSyncedAt
    const boundary = new Set(this.record.boundaryIds)
    const allNew: UnifiedMessage[] = []
    for (const conv of conversations) {
      const msgs = await this.store.listMessages(conv.id, 1000)
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
      if (accountProfiles.length > 0) await this.post(cfg, '/api/sync', { conversations: [], messages: [], accountProfiles })
      return { conversations: 0, messages: 0 }
    }

    let synced = 0
    let maxTs = since
    for (let i = 0; i < allNew.length; i += BATCH_SIZE) {
      const batch = allNew.slice(i, i + BATCH_SIZE)
      const convIds = new Set(batch.map((m) => m.conversationId))
      // 首批带上全量会话列表（不止本批有新消息的那些）：客户端连接后会回填历史会话的
      // contactId 并刷新昵称/头像，但这些会话若无新消息，原本永远传不上去。服务端 /api/sync
      // 对会话是 COALESCE upsert（不会用空值回退已有数据），首批全量即可把回填的身份与元信息
      // 一并同步过去。后续批只带本批相关会话，避免重复。
      const convsForBatch =
        i === 0 ? conversations : conversations.filter((c) => convIds.has(c.id))
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
    this.record = { lastSyncedAt: maxTs, boundaryIds: [...new Set(newBoundary)] }
    await this.persistRecord(this.record)
    this.log.info('同步完成', { messages: synced })
    return { conversations: conversations.length, messages: synced }
  }

  private async uploadMedia(cfg: SyncConfig, batch: UnifiedMessage[]): Promise<void> {
    const mediaIds = batch
      .map((m) => (m.body.type === 'media' ? m.body.mediaId : undefined))
      .filter((id): id is string => !!id)
    if (mediaIds.length === 0) return

    const { missing } = (await this.post(cfg, '/api/media/missing', { mediaIds })) as {
      missing: string[]
    }
    for (const mediaId of missing) {
      const path = this.media!.resolvePath(mediaId)
      if (!path) continue
      const buf = await readFile(path)
      await fetch(`${cfg.serverUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${cfg.token}` },
        body: new Uint8Array(buf)
      })
    }
  }

  private async uploadProfileMedia(cfg: SyncConfig, profiles: SyncAccountProfile[]): Promise<void> {
    if (!this.media) return
    const mediaIds = profiles.map((p) => p.avatarMediaId).filter((id): id is string => !!id)
    if (mediaIds.length === 0) return
    const { missing } = (await this.post(cfg, '/api/media/missing', { mediaIds })) as { missing: string[] }
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
}

function mapConversation(c: Conversation): Record<string, unknown> {
  return {
    id: c.id,
    channel: c.channel,
    accountId: c.accountId,
    contactId: c.contactId,
    title: c.title,
    isGroup: c.isGroup,
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
      caption: m.body.caption
    }
  }
  return { ...base, bodyType: 'unsupported', text: m.body.description }
}

// 延迟引入，避免核心层顶层依赖 node:fs（保持可测试）
async function readFile(path: string): Promise<Buffer> {
  const { readFile: rf } = await import('node:fs/promises')
  return rf(path)
}
