import { chmodSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { FileStorage } from '@evex/linejs/storage'
import { loginWithAuthToken, loginWithQR, type Client, type TalkMessage } from '@evex/linejs'
import QRCode from 'qrcode'
import type { ChannelStatus, MessageBody, UnifiedMessage } from '@shared/domain'
import { conversationId } from '@shared/domain'
import { ChannelAdapter, type OutboundMedia, type OutboundResult } from '../../core/channel-adapter'
import { noopLogger, type Logger } from '../../core/logger'
import { createRequiredDispatcher, redactProxyUrl, withDispatcher } from '../../core/proxy'
import type { Dispatcher } from 'undici'
import { lineContactId } from './mapper'

export interface LineAdapterOptions {
  accountId: string
  /** 每个 LINE 账号各自的 token、E2EE 密钥与登录证书文件。 */
  sessionFile: string
  logger?: Logger
  getAuthToken: () => string | undefined
  saveAuthToken: (authToken: string | undefined) => Promise<void>
  getProxyUrl?: () => string | undefined
  saveMedia?: (data: Buffer, ext: string) => Promise<string>
}

type RawLineMessage = {
  id: string
  from: string
  to: string
  toType: string
  text?: string
  contentType?: string
  contentMetadata?: Record<string, string>
  createdTime?: number | string | bigint
}

type LineContactProfile = {
  displayName: string
}

type LineBuddyDetail = {
  searchId?: string
}

/**
 * 普通 LINE 账号适配器。
 *
 * 登录与收发全部运行在桌面端：客户扫描本机生成的二维码，授权令牌和 E2EE
 * 密钥只写入该账号专属 session 文件，不经由本项目后台服务器。
 */
export class LineAdapter extends ChannelAdapter {
  readonly kind = 'line' as const
  readonly accountId: string

  private readonly sessionFile: string
  private readonly log: Logger
  private readonly getAuthToken: () => string | undefined
  private readonly saveAuthToken: (authToken: string | undefined) => Promise<void>
  private readonly getProxyUrl: () => string | undefined
  private readonly saveMedia?: (data: Buffer, ext: string) => Promise<string>

  private status: ChannelStatus = 'stopped'
  private client: Client | undefined
  private abort: AbortController | undefined
  private dispatcher: Dispatcher | undefined
  private currentQrDataUrl: string | undefined
  private loginAttempt = 0
  private starting: Promise<void> | undefined
  /** 运行时读取，绝不把某个客户账号的 MID 写入代码。 */
  private selfMid: string | undefined
  private readonly contactProfiles = new Map<string, Promise<LineContactProfile | undefined>>()
  private readonly publicIds = new Map<string, Promise<string | undefined>>()

  constructor(opts: LineAdapterOptions) {
    super()
    this.accountId = opts.accountId
    this.sessionFile = opts.sessionFile
    this.log = (opts.logger ?? noopLogger).child(`line:${opts.accountId}`)
    this.getAuthToken = opts.getAuthToken
    this.saveAuthToken = opts.saveAuthToken
    this.getProxyUrl = opts.getProxyUrl ?? (() => undefined)
    this.saveMedia = opts.saveMedia
  }

  /**
   * 不等待用户完成扫码：这样新增账号 IPC 能立即返回，渲染层随即展示二维码。
   */
  async start(): Promise<void> {
    if (this.client || this.starting) return
    const attempt = ++this.loginAttempt
    this.setState('connecting', { detail: '正在连接 LINE…' })
    this.starting = this.connect(attempt).finally(() => {
      if (attempt === this.loginAttempt) this.starting = undefined
    })
    void this.starting
  }

  async stop(): Promise<void> {
    this.loginAttempt++
    this.abort?.abort()
    this.abort = undefined
    this.client = undefined
    this.currentQrDataUrl = undefined
    await this.closeDispatcher()
    this.setState('stopped')
  }

  async logout(): Promise<void> {
    await this.stop()
    try {
      const storage = this.createStorage()
      await storage.clear()
      await this.saveAuthToken(undefined)
    } catch (err) {
      this.log.warn('清除本地 LINE 会话失败', { err: String(err) })
    }
    this.setState('logged_out')
  }

  async sendText(externalChatId: string, text: string): Promise<OutboundResult> {
    const client = this.requireClient()
    const sent = await client.base.talk.sendMessage({ to: externalChatId, text, e2ee: true })
    return { externalId: sent.id }
  }

  override async sendMedia(externalChatId: string, media: OutboundMedia): Promise<OutboundResult> {
    const client = this.requireClient()
    const data = await readFile(media.filePath)
    const sent = await client.base.obs.uploadMediaByE2EE({
      to: externalChatId,
      data: new Blob([new Uint8Array(data)], { type: media.mimeType }),
      oType: mediaTypeForUpload(media.mediaType),
      filename: media.fileName
    })
    return { externalId: sent.id }
  }

  override async resolveContactId(externalChatId: string): Promise<string | undefined> {
    return lineContactId(externalChatId, `account-${this.accountId}`)
  }

  /**
   * 会话事件只携带对方 MID；在需要展示名称时再向 LINE 查询资料。
   * 自聊没有独立联系人资料，故以当前已登录账号的 MID 动态识别为备忘录。
   */
  override async fetchTitle(externalChatId: string): Promise<string | undefined> {
    if (!this.client || this.status !== 'connected') return undefined
    if (this.selfMid && externalChatId.toLowerCase() === this.selfMid) return 'Keep 备忘录'
    if (!/^[Uu]/.test(externalChatId)) return undefined
    return (await this.getContactProfile(externalChatId))?.displayName
  }

  /**
   * 官方账号资料页展示的公开 @ID 不在普通联系人接口内，而在 BuddyService 的 searchId。
   * 该请求只以会话 MID 查询，返回值经过格式校验后才展示；普通用户不会得到公开 ID。
   */
  override fetchPublicId(externalChatId: string): Promise<string | undefined> {
    if (!this.client || this.status !== 'connected' || externalChatId.toLowerCase() === this.selfMid) {
      return Promise.resolve(undefined)
    }
    const key = externalChatId.toLowerCase()
    const cached = this.publicIds.get(key)
    if (cached) return cached
    const request = this.getOfficialAccountId(externalChatId)
    this.publicIds.set(key, request)
    return request
  }

  private async connect(attempt: number): Promise<void> {
    try {
      await this.closeDispatcher()
      const proxyUrl = this.getProxyUrl()
      this.dispatcher = createRequiredDispatcher(proxyUrl)
      this.log.info('使用账号独立代理连接 LINE', { proxy: redactProxyUrl(proxyUrl ?? '') })
      mkdirSync(dirname(this.sessionFile), { recursive: true, mode: 0o700 })
      const storage = this.createStorage()
      const init = {
        device: 'ANDROIDSECONDARY' as const,
        storage,
        fetch: this.proxyFetch.bind(this)
      }

      let client: Client
      const token = this.getAuthToken()?.trim()
      if (token) {
        try {
          client = await loginWithAuthToken(token, init)
        } catch (err) {
          this.log.warn('保存的 LINE 会话已失效，改为扫码登录', { err: String(err) })
          await this.saveAuthToken(undefined)
          client = await this.loginByQr(init, attempt)
        }
      } else {
        client = await this.loginByQr(init, attempt)
      }

      if (attempt !== this.loginAttempt) {
        await this.closeDispatcher()
        return
      }
      this.client = client
      // loginWithQR 在 resolve 前就发出了 update:authtoken 事件；这里再保存一次，
      // 确保首次扫码的 token 不会因监听器稍后注册而丢失。
      await this.saveAuthToken(client.authToken)
      client.base.on('update:authtoken', (authToken) => {
        void this.saveAuthToken(authToken).catch((err) => {
          this.log.warn('保存 LINE 授权令牌失败', { err: String(err) })
        })
      })
      this.abort = new AbortController()
      client.on('message', (message) => this.handleMessage(message))
      client.listen({ talk: true, square: false, signal: this.abort.signal })

      const profile = await client.getMyProfile()
      this.selfMid = profile.mid.toLowerCase()
      this.contactProfiles.clear()
      this.publicIds.clear()
      this.currentQrDataUrl = undefined
      this.setState('connected', { selfName: profile.displayName || 'LINE' })
      this.log.info('LINE 已连接', { accountId: this.accountId })
    } catch (err) {
      if (attempt !== this.loginAttempt) return
      this.log.error('LINE 连接失败', err)
      await this.closeDispatcher()
      this.setState('error', { detail: err instanceof Error ? err.message : String(err) })
    }
  }

  private async loginByQr(
    init: Parameters<typeof loginWithQR>[1],
    attempt: number
  ): Promise<Client> {
    return loginWithQR(
      {
        onReceiveQRUrl: async (url) => {
          const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 })
          if (attempt !== this.loginAttempt) return
          this.currentQrDataUrl = dataUrl
          this.setState('waiting_qr', {
            qrDataUrl: dataUrl,
            verificationCode: undefined,
            detail: '打开手机 LINE，使用“扫描二维码”扫描此码。'
          })
        },
        onPincodeRequest: (pin) => {
          if (attempt !== this.loginAttempt) return
          this.setState('waiting_qr', {
            qrDataUrl: this.currentQrDataUrl,
            verificationCode: pin,
            detail: '手机 LINE 正在要求验证码，请输入下方 PIN 完成身份验证。'
          })
        }
      },
      init
    )
  }

  private handleMessage(message: TalkMessage): void {
    // 手机端发出的消息也必须同步：客服可能在手机上临时回复，或测试「备忘录」。
    // ChannelManager 按平台 externalId 去重，因此电脑端从 OmniChat 发送的回显不会重复展示。
    const raw = message.raw as RawLineMessage
    const externalChatId = lineChatId(message, raw)
    const contentType = String(raw.contentType ?? 'NONE').toUpperCase()
    const { body, needsDownload } = lineBody(raw, contentType)
    const unified: UnifiedMessage = {
      id: `${this.accountId}:${raw.id}`,
      externalId: raw.id,
      channel: 'line',
      accountId: this.accountId,
      conversationId: conversationId('line', this.accountId, externalChatId),
      direction: message.isMyMessage ? 'out' : 'in',
      body,
      timestamp: toTimestamp(raw.createdTime),
      status: 'delivered'
    }
    this.emit('message', unified)
    this.emit('conversation', {
      externalChatId,
      isGroup: isLineGroup(message, raw)
    })
    if (needsDownload && this.saveMedia && unified.body.type === 'media') {
      void this.downloadMedia(message, unified)
    }
  }

  private async downloadMedia(message: TalkMessage, unified: UnifiedMessage): Promise<void> {
    if (!this.saveMedia || unified.body.type !== 'media') return
    try {
      const blob = await message.getData()
      const data = Buffer.from(await blob.arrayBuffer())
      if (data.length === 0) return
      const mediaId = await this.saveMedia(data, extensionFor(unified.body.mediaType, blob.type))
      this.emit('messageUpdate', { ...unified, body: { ...unified.body, mediaId, mimeType: blob.type } })
    } catch (err) {
      this.log.warn('LINE 媒体下载失败', { id: unified.externalId, err: String(err) })
    }
  }

  private createStorage(): FileStorage {
    mkdirSync(dirname(this.sessionFile), { recursive: true, mode: 0o700 })
    const storage = new FileStorage(this.sessionFile)
    // FileStorage 自身不会设置权限；会话内含 refresh token 与 E2EE 密钥，
    // 因此只允许当前桌面用户读取。
    chmodSync(this.sessionFile, 0o600)
    return storage
  }

  private getContactProfile(mid: string): Promise<LineContactProfile | undefined> {
    const key = mid.toLowerCase()
    const cached = this.contactProfiles.get(key)
    if (cached) return cached

    const request = (async (): Promise<LineContactProfile | undefined> => {
      const client = this.client
      if (!client || this.status !== 'connected') return undefined
      try {
        const user = await client.getUser(mid)
        const displayName = user.raw.targetProfileDetail?.profileName?.trim()
        return displayName ? { displayName } : undefined
      } catch (err) {
        // 联系人可能未加好友或资料不可见；保留 MID 仅作内部匹配，界面不展示。
        this.log.debug('LINE 联系人资料读取失败', { mid, err: String(err) })
        return undefined
      }
    })()
    this.contactProfiles.set(key, request)
    return request
  }

  private async getOfficialAccountId(mid: string): Promise<string | undefined> {
    const client = this.client
    if (!client || this.status !== 'connected') return undefined
    try {
      // linejs 已生成 BuddyService 但尚未挂到 BaseClient；调用同一份已验证的 Thrift
      // 请求结构，避免引入未维护的浏览器抓包依赖。
      const detail = await client.base.request.request<LineBuddyDetail>(
        [[11, 4, mid]],
        'getBuddyDetail',
        4,
        'BuddyDetail',
        '/BUDDY4'
      )
      const id = detail.searchId?.trim().replace(/^@/, '')
      return id && /^[a-z0-9._-]{1,64}$/i.test(id) ? `@${id}` : undefined
    } catch (err) {
      // 非官方账号会被该接口拒绝，这是预期情况，不影响普通联系人资料读取。
      this.log.debug('LINE 官方账号公开 ID 读取失败', { err: String(err) })
      return undefined
    }
  }

  private proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return fetch(input, withDispatcher(init ?? {}, this.requiredDispatcher()))
  }

  private requiredDispatcher(): Dispatcher {
    if (!this.dispatcher) throw new Error('代理链路已断开，安全隔离已阻止直连')
    return this.dispatcher
  }

  private async closeDispatcher(): Promise<void> {
    const dispatcher = this.dispatcher
    this.dispatcher = undefined
    if (dispatcher) await dispatcher.close().catch(() => undefined)
  }

  private requireClient(): Client {
    if (!this.client || this.status !== 'connected') throw new Error('LINE 未连接，无法发送消息')
    return this.client
  }

  private setState(
    status: ChannelStatus,
    extra: { detail?: string; qrDataUrl?: string; verificationCode?: string; selfName?: string } = {}
  ): void {
    this.status = status
    this.emit('state', this.makeState({ status, ...extra }))
  }
}

function lineChatId(message: TalkMessage, raw: RawLineMessage): string {
  if (isLineGroup(message, raw)) return raw.to
  return message.isMyMessage ? raw.to : raw.from
}

function isLineGroup(message: TalkMessage, raw: RawLineMessage): boolean {
  const type = String(message.to.type ?? raw.toType).toUpperCase()
  return type === 'GROUP' || type === 'ROOM' || /^[CcRr]/.test(raw.to)
}

function lineBody(raw: RawLineMessage, contentType: string): { body: MessageBody; needsDownload: boolean } {
  switch (contentType) {
    case 'NONE':
      return { body: { type: 'text', text: raw.text ?? '' }, needsDownload: false }
    case 'IMAGE':
      return { body: { type: 'media', mediaType: 'image' }, needsDownload: true }
    case 'VIDEO':
      return { body: { type: 'media', mediaType: 'video' }, needsDownload: true }
    case 'AUDIO':
      return { body: { type: 'media', mediaType: 'audio' }, needsDownload: true }
    case 'FILE':
      return {
        body: { type: 'media', mediaType: 'document', fileName: raw.contentMetadata?.FILE_NAME },
        needsDownload: true
      }
    case 'STICKER':
      return { body: { type: 'media', mediaType: 'sticker' }, needsDownload: false }
    default:
      return { body: { type: 'unsupported', description: `line-${contentType.toLowerCase()}` }, needsDownload: false }
  }
}

function mediaTypeForUpload(type: OutboundMedia['mediaType']): 'image' | 'video' | 'audio' | 'file' {
  if (type === 'image' || type === 'video' || type === 'audio') return type
  return 'file'
}

function extensionFor(type: 'image' | 'video' | 'audio' | 'document' | 'sticker', mime: string): string {
  if (mime.includes('png')) return '.png'
  if (mime.includes('webp')) return '.webp'
  if (mime.includes('mpeg')) return '.mp3'
  if (mime.includes('ogg')) return '.ogg'
  if (mime.includes('mp4')) return type === 'audio' ? '.m4a' : '.mp4'
  return type === 'image' ? '.jpg' : type === 'video' ? '.mp4' : type === 'audio' ? '.m4a' : '.bin'
}

function toTimestamp(value: RawLineMessage['createdTime']): number {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now()
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed
}
