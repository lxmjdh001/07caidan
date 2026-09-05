import type { Dispatcher } from 'undici'
import type { ChannelStatus } from '@shared/domain'
import { ChannelAdapter, type OutboundResult } from '../../core/channel-adapter'
import { extFromMime } from '../../core/mime'
import { noopLogger, type Logger } from '../../core/logger'
import { createRequiredDispatcher, withDispatcher } from '../../core/proxy'
import { mapSnapchatMessage, previewSnapchatMessage, type SnapchatMessageInput } from './mapper'

interface SnapchatAccount {
  channel: 'snapchat'
  accountId: string
  profileId: string
  displayName: string
  handle?: string
  avatarUrl?: string
}

interface SnapchatStatusResponse {
  status: 'connected' | 'authorizing' | 'error' | 'disconnected'
  detail?: string
  account?: SnapchatAccount
}

interface SnapchatHistoryResponse {
  conversations?: Array<{
    externalChatId: string
    title: string
    publicId?: string
    contactId: string
    avatarUrl?: string
    updatedTime: number
    messages: SnapchatMessageInput[]
  }>
}

interface SnapchatProfile {
  id: string
  name?: string
  username?: string
  avatarUrl?: string
  contactId: string
}

export interface SnapchatAdapterOptions {
  accountId: string
  logger?: Logger
  getBackend: () => { url?: string; token?: string }
  getCreatorProfileIds: () => string | undefined
  openExternal: (url: string) => Promise<void>
  getProxyUrl?: () => string | undefined
  saveMedia?: (data: Buffer, ext: string) => Promise<string>
}

const OAUTH_POLL_MS = 2_000
const HISTORY_POLL_MS = 60_000
const MAX_MEDIA_BYTES = 20 * 1024 * 1024

export class SnapchatAdapter extends ChannelAdapter {
  readonly kind = 'snapchat' as const
  readonly accountId: string

  private readonly log: Logger
  private readonly getBackend: () => { url?: string; token?: string }
  private readonly getCreatorProfileIds: () => string | undefined
  private readonly openExternal: (url: string) => Promise<void>
  private readonly getProxyUrl: () => string | undefined
  private readonly saveMedia?: (data: Buffer, ext: string) => Promise<string>
  private status: ChannelStatus = 'stopped'
  private account: SnapchatAccount | undefined
  private oauthTimer: ReturnType<typeof setInterval> | undefined
  private historyTimer: ReturnType<typeof setInterval> | undefined
  private pollingOauth = false
  private pollingHistory = false
  private starting: Promise<void> | undefined
  private initialized = false
  private creatorSignature = ''
  private dispatcher: Dispatcher | undefined
  private readonly seenIds = new Set<string>()
  private readonly profiles = new Map<string, SnapchatProfile>()

  constructor(options: SnapchatAdapterOptions) {
    super()
    this.accountId = options.accountId
    this.log = (options.logger ?? noopLogger).child(`snapchat:${options.accountId}`)
    this.getBackend = options.getBackend
    this.getCreatorProfileIds = options.getCreatorProfileIds
    this.openExternal = options.openExternal
    this.getProxyUrl = options.getProxyUrl ?? (() => undefined)
    this.saveMedia = options.saveMedia
  }

  async start(): Promise<void> {
    if (this.starting || this.historyTimer) return
    await this.resetDispatcher()
    this.starting = this.connectExisting().finally(() => { this.starting = undefined })
    await this.starting
  }

  override async beginOAuth(): Promise<void> {
    this.requireBackend()
    await this.resetDispatcher()
    this.clearOauthTimer()
    this.setState('connecting', { detail: '正在创建 Snapchat 安全授权链接…' })
    try {
      const response = await this.api<{ url?: string }>('/api/snapchat/oauth/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: this.accountId })
      })
      if (!response.url || new URL(response.url).hostname !== 'accounts.snapchat.com') {
        throw new Error('服务器返回的 Snapchat 授权地址无效')
      }
      await this.openExternal(response.url)
      this.setState('waiting_oauth', {
        detail: '请授权品牌 Public Profile。此官方接口仅支持与创作者的合作消息。'
      })
      this.oauthTimer = setInterval(() => void this.pollOauth(), OAUTH_POLL_MS)
      this.oauthTimer.unref?.()
    } catch (error) {
      this.setState('error', { detail: errorMessage(error) })
      throw error
    }
  }

  async stop(): Promise<void> {
    this.clearTimers()
    await this.closeDispatcher()
    this.setState('stopped')
  }

  async logout(): Promise<void> {
    this.clearTimers()
    try {
      await this.api(`/api/snapchat/account?${new URLSearchParams({ accountId: this.accountId })}`, { method: 'DELETE' })
    } catch (error) {
      this.log.warn('服务端 Snapchat 账号解绑失败', { error: errorMessage(error) })
    }
    this.account = undefined
    this.profiles.clear()
    this.seenIds.clear()
    this.initialized = false
    await this.closeDispatcher()
    this.creatorSignature = ''
    this.setState('logged_out')
  }

  async sendText(externalChatId: string, text: string): Promise<OutboundResult> {
    this.assertConnected()
    const result = await this.api<{ messageId?: string }>('/api/snapchat/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: this.accountId, conversationId: externalChatId, text })
    })
    return { externalId: result.messageId }
  }

  override async fetchTitle(externalChatId: string): Promise<string | undefined> {
    return this.profiles.get(externalChatId)?.name
  }

  override async fetchPublicId(externalChatId: string): Promise<string | undefined> {
    const username = this.profiles.get(externalChatId)?.username
    return username ? `@${username.replace(/^@/, '')}` : undefined
  }

  override async resolveContactId(externalChatId: string): Promise<string | undefined> {
    return this.profiles.get(externalChatId)?.contactId
  }

  override async fetchAvatar(externalChatId: string): Promise<string | undefined> {
    const url = this.profiles.get(externalChatId)?.avatarUrl
    return url ? this.downloadAvatar(url) : undefined
  }

  override async fetchSelfAvatar(): Promise<string | undefined> {
    return this.account?.avatarUrl ? this.downloadAvatar(this.account.avatarUrl) : undefined
  }

  private async connectExisting(): Promise<void> {
    try {
      this.requireBackend()
      this.setState('connecting', { detail: '正在检查 Snapchat 授权…' })
      const status = await this.fetchStatus()
      if (status.status === 'connected' && status.account) return await this.onConnected(status.account)
      if (status.status === 'authorizing') {
        this.setState('waiting_oauth', { detail: status.detail })
        this.oauthTimer = setInterval(() => void this.pollOauth(), OAUTH_POLL_MS)
        this.oauthTimer.unref?.()
      } else if (status.status === 'error') {
        this.setState('error', { detail: status.detail })
      } else {
        this.setState('need_credentials', { detail: status.detail })
      }
    } catch (error) {
      this.setState('error', { detail: errorMessage(error) })
    }
  }

  private async pollOauth(): Promise<void> {
    if (this.pollingOauth) return
    this.pollingOauth = true
    try {
      const status = await this.fetchStatus()
      if (status.status === 'connected' && status.account) {
        this.clearOauthTimer()
        await this.onConnected(status.account)
      } else if (status.status === 'error') {
        this.clearOauthTimer()
        this.setState('error', { detail: status.detail })
      } else if (status.status === 'disconnected') {
        this.clearOauthTimer()
        this.setState('need_credentials', { detail: status.detail })
      }
    } catch (error) {
      this.log.debug('Snapchat 授权状态轮询失败，下轮重试', { error: errorMessage(error) })
    } finally {
      this.pollingOauth = false
    }
  }

  private async onConnected(account: SnapchatAccount): Promise<void> {
    this.account = account
    this.requiredDispatcher()
    this.setState('connected', {
      selfName: account.displayName,
      selfHandle: account.handle ? `@${account.handle.replace(/^@/, '')}` : undefined,
      detail: '官方 Public Profile Messaging：仅限品牌与已绑定创作者的合作消息。'
    })
    await this.pollHistory(true)
    if (!this.historyTimer) {
      this.historyTimer = setInterval(() => void this.pollHistory(), HISTORY_POLL_MS)
      this.historyTimer.unref?.()
    }
  }

  private async pollHistory(initial = false): Promise<void> {
    if (this.pollingHistory || !this.account || this.status !== 'connected') return
    this.pollingHistory = true
    try {
      await this.reconcileCreators()
      const query = new URLSearchParams({ accountId: this.accountId })
      const response = await this.api<SnapchatHistoryResponse>(`/api/snapchat/history?${query}`)
      for (const conversation of response.conversations ?? []) {
        this.profiles.set(conversation.externalChatId, {
          id: contactTail(conversation.contactId) || conversation.externalChatId,
          name: conversation.title,
          username: conversation.publicId?.replace(/^@/, ''),
          avatarUrl: conversation.avatarUrl,
          contactId: conversation.contactId
        })
        this.emit('conversation', {
          externalChatId: conversation.externalChatId,
          title: conversation.title,
          publicId: conversation.publicId,
          contactId: conversation.contactId,
          isGroup: false,
          lastMessageAt: conversation.updatedTime,
          lastMessagePreview: previewSnapchatMessage(conversation.messages.at(-1))
        })
        for (const raw of conversation.messages) {
          const message = mapSnapchatMessage(raw, this.accountId, conversation.externalChatId)
          const id = message.externalId || message.id
          if (this.seenIds.has(id)) continue
          this.remember(id)
          this.emit(initial || !this.initialized ? 'historyMessage' : 'message', message)
        }
      }
      this.initialized = true
    } catch (error) {
      this.log.warn('Snapchat 创作者消息读取失败，下轮自动重试', { error: errorMessage(error) })
    } finally {
      this.pollingHistory = false
    }
  }

  private async reconcileCreators(): Promise<void> {
    const ids = parseCreatorIds(this.getCreatorProfileIds())
    const signature = ids.join(',')
    if (!signature || signature === this.creatorSignature) return
    await this.api('/api/snapchat/creators/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: this.accountId, creatorProfileIds: ids })
    })
    this.creatorSignature = signature
  }

  private async downloadAvatar(url: string): Promise<string | undefined> {
    if (!this.saveMedia || !safeSnapUrl(url)) return undefined
    try {
      const response = await fetch(url, withDispatcher({ signal: AbortSignal.timeout(30_000) }, this.requiredDispatcher()))
      if (!response.ok || Number(response.headers.get('content-length') || 0) > MAX_MEDIA_BYTES) return undefined
      const data = Buffer.from(await response.arrayBuffer())
      if (data.length === 0 || data.length > MAX_MEDIA_BYTES) return undefined
      return await this.saveMedia(data, extFromMime(response.headers.get('content-type') || undefined))
    } catch (error) {
      this.log.debug('Snapchat 头像下载失败', { error: errorMessage(error) })
      return undefined
    }
  }

  private remember(id: string): void {
    this.seenIds.add(id)
    if (this.seenIds.size > 20_000) this.seenIds.delete(this.seenIds.values().next().value!)
  }

  private fetchStatus(): Promise<SnapchatStatusResponse> {
    return this.api(`/api/snapchat/account?${new URLSearchParams({ accountId: this.accountId })}`)
  }

  private assertConnected(): void {
    if (!this.account || this.status !== 'connected') throw new Error('Snapchat 公共主页尚未连接')
  }

  private requireBackend(): { base: string; token: string } {
    const backend = this.getBackend()
    const base = backend.url?.replace(/\/$/, '')
    const token = backend.token?.trim()
    if (!base || !token) throw new Error('请先登录 OmniChat 后台，再授权 Snapchat 公共主页。')
    return { base, token }
  }

  private async api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const { base, token } = this.requireBackend()
    const response = await fetch(
      `${base}${path}`,
      withDispatcher({
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers).entries()), authorization: `Bearer ${token}` },
        signal: init.signal ?? AbortSignal.timeout(30_000)
      }, this.requiredDispatcher())
    )
    const raw = await response.text()
    let data: { error?: string }
    try { data = raw ? JSON.parse(raw) as { error?: string } : {} } catch { throw new Error(`OmniChat 后台返回了无法解析的数据（HTTP ${response.status}）`) }
    if (!response.ok) throw new Error(data.error || `OmniChat 后台 HTTP ${response.status}`)
    return data as T
  }

  private clearOauthTimer(): void {
    if (this.oauthTimer) clearInterval(this.oauthTimer)
    this.oauthTimer = undefined
  }

  private clearTimers(): void {
    this.clearOauthTimer()
    if (this.historyTimer) clearInterval(this.historyTimer)
    this.historyTimer = undefined
  }

  private requiredDispatcher(): Dispatcher {
    if (!this.dispatcher) throw new Error('代理链路已断开，安全隔离已阻止直连')
    return this.dispatcher
  }

  private async resetDispatcher(): Promise<void> {
    await this.closeDispatcher()
    this.dispatcher = createRequiredDispatcher(this.getProxyUrl())
  }

  private async closeDispatcher(): Promise<void> {
    const dispatcher = this.dispatcher
    this.dispatcher = undefined
    if (dispatcher) await dispatcher.close().catch(() => undefined)
  }

  private setState(status: ChannelStatus, extra: { detail?: string; selfName?: string; selfHandle?: string } = {}): void {
    this.status = status
    this.emit('state', this.makeState({ status, ...extra }))
  }
}

function parseCreatorIds(value: string | undefined): string[] {
  return [...new Set((value || '').split(/[\s,;，；]+/).map((id) => id.trim()).filter(Boolean))].slice(0, 100)
}

function contactTail(value: string): string | undefined {
  const index = value.lastIndexOf(':')
  return index >= 0 ? value.slice(index + 1) : undefined
}

function safeSnapUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const host = url.hostname.toLowerCase()
    return host === 'snapchat.com' || host.endsWith('.snapchat.com') || host === 'snap.com' ||
      host.endsWith('.snap.com') || host === 'sc-cdn.net' || host.endsWith('.sc-cdn.net')
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
