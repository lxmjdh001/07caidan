import { readFile } from 'node:fs/promises'
import type { ChannelStatus, UnifiedMessage } from '@shared/domain'
import { ChannelAdapter, type OutboundMedia, type OutboundResult } from '../../core/channel-adapter'
import { noopLogger, type Logger } from '../../core/logger'
import { extFromMime } from '../../core/mime'
import {
  chatTitle,
  isGroupChat,
  mapTgMessage,
  type TgMessage,
  type TgUpdate,
  type TgUser
} from './mapper'

export interface TelegramAdapterOptions {
  accountId: string
  logger?: Logger
  /** 读取 Bot Token（在账号设置里填）；空 = 需要填凭证 */
  getBotToken: () => string | undefined
  saveMedia?: (data: Buffer, ext: string) => Promise<string>
}

const POLL_TIMEOUT_S = 30
const MAX_MEDIA_BYTES = 50 * 1024 * 1024 // Telegram Bot API 下载上限 20MB，留余量

/**
 * Telegram 渠道适配器（Bot API 长轮询，纯客户端，无需服务器）。
 * 凭证是 Bot Token（不是扫码）。收发消息、下载媒体全部走 HTTPS。
 */
export class TelegramAdapter extends ChannelAdapter {
  readonly kind = 'telegram_bot' as const
  readonly accountId: string

  private readonly log: Logger
  private readonly getBotToken: () => string | undefined
  private readonly saveMedia?: (data: Buffer, ext: string) => Promise<string>

  private status: ChannelStatus = 'stopped'
  private stopping = false
  private polling = false
  private offset = 0
  private selfId = 0
  private abort: AbortController | undefined

  constructor(opts: TelegramAdapterOptions) {
    super()
    this.accountId = opts.accountId
    this.log = (opts.logger ?? noopLogger).child(`telegram:${opts.accountId}`)
    this.getBotToken = opts.getBotToken
    this.saveMedia = opts.saveMedia
  }

  async start(): Promise<void> {
    this.stopping = false
    const token = this.getBotToken()
    if (!token) {
      this.setState('need_credentials', { detail: '请在账号设置填写 Bot Token' })
      return
    }
    this.setState('connecting')
    try {
      const me = await this.call<TgUser>('getMe')
      this.selfId = me.id
      const name = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username
      this.setState('connected', { selfName: name })
      this.log.info('连接成功', { bot: me.username })
      void this.pollLoop()
    } catch (err) {
      this.log.error('连接失败', err)
      this.setState('error', { detail: err instanceof Error ? err.message : String(err) })
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.abort?.abort()
    this.setState('stopped')
  }

  async logout(): Promise<void> {
    await this.stop()
    this.setState('logged_out')
  }

  async sendText(externalChatId: string, text: string): Promise<OutboundResult> {
    const r = await this.call<TgMessage>('sendMessage', { chat_id: externalChatId, text })
    return { externalId: String(r.message_id) }
  }

  override async sendMedia(externalChatId: string, media: OutboundMedia): Promise<OutboundResult> {
    const buf = await readFile(media.filePath)
    const { method, field } = mediaMethod(media.mediaType)
    const form = new FormData()
    form.append('chat_id', externalChatId)
    if (media.caption) form.append('caption', media.caption)
    form.append(field, new Blob([new Uint8Array(buf)], { type: media.mimeType }), media.fileName)
    const r = await this.callForm<TgMessage>(method, form)
    return { externalId: String(r.message_id) }
  }

  private async pollLoop(): Promise<void> {
    if (this.polling) return
    this.polling = true
    while (!this.stopping) {
      try {
        this.abort = new AbortController()
        const updates = await this.call<TgUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
          this.abort.signal,
          (POLL_TIMEOUT_S + 10) * 1000
        )
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1)
          if (u.message) this.handleMessage(u.message)
        }
      } catch (err) {
        if (this.stopping) break
        this.log.warn('长轮询出错，稍后重试', { err: String(err) })
        await sleep(3000)
      }
    }
    this.polling = false
  }

  private handleMessage(m: TgMessage): void {
    const mapped = mapTgMessage(m, this.accountId, this.selfId)
    if (!mapped) return
    this.emit('message', mapped.message)
    this.emit('conversation', {
      externalChatId: String(m.chat.id),
      title: chatTitle(m.chat),
      isGroup: isGroupChat(m.chat)
    })
    if (mapped.fileId && this.saveMedia && mapped.message.body.type === 'media') {
      void this.downloadMedia(mapped.fileId, mapped.message)
    }
  }

  private async downloadMedia(fileId: string, msg: UnifiedMessage): Promise<void> {
    if (!this.saveMedia || msg.body.type !== 'media') return
    try {
      const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', {
        file_id: fileId
      })
      if (!file.file_path) return
      if ((file.file_size ?? 0) > MAX_MEDIA_BYTES) {
        this.log.warn('媒体过大，跳过下载', { size: file.file_size })
        return
      }
      const token = this.getBotToken()!
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) return
      const buf = Buffer.from(await res.arrayBuffer())
      const mediaId = await this.saveMedia(buf, extFromMime(msg.body.mimeType))
      this.emit('messageUpdate', { ...msg, body: { ...msg.body, mediaId } })
    } catch (err) {
      this.log.warn('媒体下载失败', { err: String(err) })
    }
  }

  /** 调 Bot API（JSON） */
  private async call<T>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 20_000
  ): Promise<T> {
    const token = this.getBotToken()
    if (!token) throw new Error('缺少 Bot Token')
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params ?? {}),
      signal: signal ?? AbortSignal.timeout(timeoutMs)
    })
    return this.parse<T>(res)
  }

  private async callForm<T>(method: string, form: FormData): Promise<T> {
    const token = this.getBotToken()
    if (!token) throw new Error('缺少 Bot Token')
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000)
    })
    return this.parse<T>(res)
  }

  private async parse<T>(res: Response): Promise<T> {
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string }
    if (!data.ok) throw new Error(data.description || `Telegram API ${res.status}`)
    return data.result as T
  }

  private setState(
    status: ChannelStatus,
    extra: { detail?: string; selfName?: string } = {}
  ): void {
    this.status = status
    this.emit('state', this.makeState({ status, ...extra }))
  }
}

function mediaMethod(kind: OutboundMedia['mediaType']): { method: string; field: string } {
  switch (kind) {
    case 'image':
    case 'sticker':
      return { method: 'sendPhoto', field: 'photo' }
    case 'video':
      return { method: 'sendVideo', field: 'video' }
    case 'audio':
      return { method: 'sendAudio', field: 'audio' }
    case 'document':
      return { method: 'sendDocument', field: 'document' }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
