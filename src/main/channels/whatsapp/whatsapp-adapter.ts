import { rm } from 'node:fs/promises'
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type AnyMessageContent,
  type WAMessage
} from 'baileys'
import pino from 'pino'
import QRCode from 'qrcode'
import type { ChannelStatus, UnifiedMessage } from '@shared/domain'
import { ChannelAdapter, type OutboundMedia, type OutboundResult } from '../../core/channel-adapter'
import { noopLogger, type Logger } from '../../core/logger'
import { extFromMime } from '../../core/mime'
import { createProxyAgent } from '../../core/proxy'
import { isGroupJid, mapWaMessage, mediaFileLength, type WaRawMessage } from './mapper'

export interface WhatsAppAdapterOptions {
  accountId: string
  /** 登录凭证目录（多账号各一个） */
  authDir: string
  logger?: Logger
  /**
   * 该账号的代理地址提供函数（socks5:// 或 http://），每次建立连接时读取，
   * 返回空 = 走默认网络。做成函数是为了改设置后重连即生效。
   */
  getProxyUrl?: () => string | undefined
  /** 保存下载的媒体，返回 mediaId（由核心层 MediaStore 提供） */
  saveMedia?: (data: Buffer, ext: string) => Promise<string>
}

const RECONNECT_BASE_MS = 3_000
const RECONNECT_MAX_MS = 60_000
/** 超过此大小的媒体不自动下载（避免大视频占满内存/磁盘） */
const MAX_MEDIA_BYTES = 100 * 1024 * 1024

/**
 * WhatsApp 渠道适配器（Baileys v7，WebSocket 直连 WhatsApp Web 协议）。
 * 连接完全跑在客户端本地：扫码登录后凭证保存在本机，流量走用户自己的网络。
 */
export class WhatsAppAdapter extends ChannelAdapter {
  readonly kind = 'whatsapp' as const
  readonly accountId: string

  private readonly authDir: string
  private readonly log: Logger
  /** Baileys 内部日志走独立的静默 pino；关键连接事件由本适配器自行记录 */
  private readonly waLogger = pino({ level: 'silent' })

  private sock: ReturnType<typeof makeWASocket> | undefined
  private status: ChannelStatus = 'stopped'
  private stopping = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectDelay = RECONNECT_BASE_MS

  private readonly getProxyUrl: () => string | undefined
  private readonly saveMedia?: (data: Buffer, ext: string) => Promise<string>

  constructor(opts: WhatsAppAdapterOptions) {
    super()
    this.accountId = opts.accountId
    this.authDir = opts.authDir
    this.getProxyUrl = opts.getProxyUrl ?? (() => undefined)
    this.saveMedia = opts.saveMedia
    this.log = (opts.logger ?? noopLogger).child(`whatsapp:${opts.accountId}`)
  }

  async start(): Promise<void> {
    this.stopping = false
    this.setState('connecting')
    try {
      await this.connect()
    } catch (err) {
      this.log.error('启动连接失败', err)
      this.setState('error', { detail: err instanceof Error ? err.message : String(err) })
      this.scheduleReconnect()
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearReconnect()
    try {
      this.sock?.end(undefined)
    } catch {
      // socket 可能已关闭
    }
    this.sock = undefined
    this.setState('stopped')
    this.log.info('已停止')
  }

  async logout(): Promise<void> {
    this.stopping = true
    this.clearReconnect()
    try {
      await this.sock?.logout()
    } catch (err) {
      this.log.warn('调用 logout 失败（可能已断开），继续清除本地凭证', err)
    }
    this.sock = undefined
    await rm(this.authDir, { recursive: true, force: true })
    this.setState('logged_out')
    this.log.info('已退出登录并清除凭证')
  }

  async sendText(externalChatId: string, text: string): Promise<OutboundResult> {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp 未连接，无法发送')
    }
    const result = await this.sock.sendMessage(externalChatId, { text })
    this.log.debug('消息已发送', { to: externalChatId, id: result?.key?.id })
    return { externalId: result?.key?.id ?? undefined }
  }

  override async sendMedia(externalChatId: string, media: OutboundMedia): Promise<OutboundResult> {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp 未连接，无法发送')
    }
    const content = toWaMediaContent(media)
    const result = await this.sock.sendMessage(externalChatId, content)
    this.log.debug('媒体已发送', { to: externalChatId, type: media.mediaType, id: result?.key?.id })
    return { externalId: result?.key?.id ?? undefined }
  }

  /** 后台下载入站媒体，成功后通过 messageUpdate 补上 mediaId */
  private async downloadIncomingMedia(raw: unknown, msg: UnifiedMessage): Promise<void> {
    if (!this.saveMedia || msg.body.type !== 'media') return

    const size = mediaFileLength((raw as WaRawMessage).message)
    if (size > MAX_MEDIA_BYTES) {
      this.log.warn('媒体超过大小上限，跳过下载', { size, externalId: msg.externalId })
      return
    }

    try {
      const buffer = (await downloadMediaMessage(raw as WAMessage, 'buffer', {}, {
        logger: this.waLogger,
        reuploadRequest: (m) => this.sock!.updateMediaMessage(m)
      })) as Buffer
      const mediaId = await this.saveMedia(buffer, extFromMime(msg.body.mimeType))
      this.emit('messageUpdate', { ...msg, body: { ...msg.body, mediaId } })
    } catch (err) {
      this.log.warn('媒体下载失败', { externalId: msg.externalId, err: String(err) })
    }
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir)

    let version: [number, number, number] | undefined
    try {
      ;({ version } = await fetchLatestBaileysVersion())
    } catch {
      this.log.warn('获取最新 WhatsApp Web 版本号失败，使用库内置版本')
    }

    const proxyUrl = this.getProxyUrl()
    const agent = createProxyAgent(proxyUrl)
    if (agent) this.log.info('使用代理连接', { proxy: proxyUrl?.replace(/\/\/.*@/, '//***@') })

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.waLogger)
      },
      agent,
      fetchAgent: agent,
      logger: this.waLogger,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        this.log.info('收到登录二维码，等待扫码')
        void QRCode.toDataURL(qr, { margin: 1, width: 320 }).then(
          (dataUrl) => this.setState('waiting_qr', { qrDataUrl: dataUrl }),
          (err) => this.log.error('二维码生成失败', err)
        )
      }

      if (connection === 'open') {
        this.reconnectDelay = RECONNECT_BASE_MS
        const selfName = sock.user?.name || sock.user?.id
        this.setState('connected', { selfName })
        this.log.info('连接成功', { user: sock.user?.id })
      }

      if (connection === 'close') {
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode
        this.log.warn('连接关闭', { statusCode })

        if (statusCode === DisconnectReason.loggedOut) {
          this.setState('logged_out', { detail: '账号已在其他设备退出登录' })
        } else if (this.stopping) {
          this.setState('stopped')
        } else {
          this.setState('connecting', { detail: '连接断开，正在重连…' })
          this.scheduleReconnect()
        }
      }
    })

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const raw of messages) {
        const mapped = mapWaMessage(raw as unknown as WaRawMessage, this.accountId)
        if (!mapped) continue
        this.emit('message', mapped)
        if (mapped.body.type === 'media') {
          void this.downloadIncomingMedia(raw, mapped)
        }
      }
    })

    // 联系人/会话元数据 → 修正会话标题
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        const title = c.name || c.notify
        if (c.id && title && !isGroupJid(c.id)) {
          this.emit('conversation', { externalChatId: c.id, title, isGroup: false })
        }
      }
    })

    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) {
        if (!c.id) continue
        this.emit('conversation', {
          externalChatId: c.id,
          title: c.name ?? undefined,
          isGroup: isGroupJid(c.id)
        })
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    this.log.info(`将在 ${Math.round(delay / 1000)}s 后重连`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch((err) => {
        this.log.error('重连失败', err)
        this.scheduleReconnect()
      })
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.reconnectDelay = RECONNECT_BASE_MS
  }

  private setState(
    status: ChannelStatus,
    extra: { detail?: string; qrDataUrl?: string; selfName?: string } = {}
  ): void {
    this.status = status
    this.emit('state', this.makeState({ status, ...extra }))
  }
}

/** OutboundMedia → Baileys 发送内容 */
function toWaMediaContent(media: OutboundMedia): AnyMessageContent {
  const source = { url: media.filePath }
  switch (media.mediaType) {
    case 'image':
    case 'sticker':
      return { image: source, caption: media.caption }
    case 'video':
      return { video: source, caption: media.caption }
    case 'audio':
      return { audio: source, mimetype: media.mimeType }
    case 'document':
      return { document: source, mimetype: media.mimeType, fileName: media.fileName }
  }
}
