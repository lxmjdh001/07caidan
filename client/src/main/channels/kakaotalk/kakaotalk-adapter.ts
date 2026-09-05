import { createHash } from 'node:crypto'
import { Long } from 'bson'
import {
  AndroidAuthClient,
  legacyAndroidSubXvcProvider,
  type AndroidClientConfiguration,
  type AndroidSessionCredential
} from '@lukim9-kakao/client-android'
import { androidReferenceLocoPublicKeyPem } from '@lukim9-kakao/protocol-profiles'
import type { ChannelDataDocument, MessagePush } from '@lukim9-kakao/protocol-android'
import type { Dispatcher } from 'undici'
import type { ChannelStatus } from '@shared/domain'
import { previewOf } from '@shared/domain'
import { ChannelAdapter, type GroupSummary, type OutboundResult } from '../../core/channel-adapter'
import { noopLogger, type Logger } from '../../core/logger'
import { createRequiredDispatcher, normalizeProxyUrl, redactProxyUrl, withDispatcher } from '../../core/proxy'
import type { AccountFingerprint } from '@shared/settings'
import { KakaoLocoClient } from './loco-client'
import { kakaoBody, kakaoConversationInfo, locoId, mapKakaoChatlog, type KakaoConversationInfo } from './mapper'

/** 2026-07 的公开实现已用该 Android 子设备画像完成真实 auth + LOGINLIST。 */
const KAKAO_CONFIGURATION: AndroidClientConfiguration = Object.freeze({
  kakaoTalkAppVersion: '25.8.1',
  reportedAndroidOsVersion: '7.1.2',
  deviceModel: 'SM-T870',
  networkType: 0,
  mccmnc: '',
  countryIso: 'KR',
  language: 'ko',
  protocolVersion: '1'
})

export interface KakaoTalkAdapterOptions {
  accountId: string
  logger?: Logger
  getCredentials: () => Record<string, string> | undefined
  saveCredentials: (credentials: Record<string, string>) => Promise<void>
  getProxyUrl?: () => string | undefined
  getFingerprint?: () => AccountFingerprint | undefined
}

interface CachedChannel {
  info: KakaoConversationInfo
  participantIds: string[]
}

/**
 * KakaoTalk Android 子设备适配器。
 *
 * 首次输入 Kakao 账号密码后，手机主设备确认八位验证码；成功后仅保存设备 UUID
 * 和 OAuth 会话令牌，密码立即从本地配置移除。每个账号都有独立设备身份与代理链路。
 */
export class KakaoTalkAdapter extends ChannelAdapter {
  readonly kind = 'kakaotalk' as const
  readonly accountId: string

  private readonly log: Logger
  private readonly opts: KakaoTalkAdapterOptions
  private status: ChannelStatus = 'stopped'
  private client: KakaoLocoClient | undefined
  private abort: AbortController | undefined
  private dispatcher: Dispatcher | undefined
  private starting: Promise<void> | undefined
  private attempt = 0
  private selfId = ''
  private readonly channels = new Map<string, CachedChannel>()

  constructor(opts: KakaoTalkAdapterOptions) {
    super()
    this.accountId = opts.accountId
    this.opts = opts
    this.log = (opts.logger ?? noopLogger).child(`kakaotalk:${opts.accountId}`)
  }

  async start(): Promise<void> {
    if (this.client?.connected || this.starting) return
    const attempt = ++this.attempt
    this.abort = new AbortController()
    this.setState('connecting', { detail: '正在连接 KakaoTalk…' })
    this.starting = this.connect(attempt, this.abort.signal).finally(() => {
      if (attempt === this.attempt) this.starting = undefined
    })
    void this.starting
  }

  async stop(): Promise<void> {
    this.attempt += 1
    this.starting = undefined
    this.abort?.abort(new Error('KakaoTalk 连接已停止'))
    this.abort = undefined
    const client = this.client
    this.client = undefined
    if (client) await client.close().catch(() => undefined)
    await this.closeDispatcher()
    this.setState('stopped')
  }

  async logout(): Promise<void> {
    await this.stop()
    this.channels.clear()
    this.selfId = ''
    await this.opts.saveCredentials({})
    this.setState('logged_out')
  }

  async sendText(externalChatId: string, text: string): Promise<OutboundResult> {
    const client = this.requireClient()
    if (!/^\d+$/.test(externalChatId)) throw new Error('KakaoTalk 会话 ID 无效')
    const sent = await client.channel(Long.fromString(externalChatId)).sendText(text)
    return { externalId: locoId(sent.logId) }
  }

  override async fetchTitle(externalChatId: string): Promise<string | undefined> {
    return this.channels.get(externalChatId)?.info.title
  }

  override async resolveContactId(externalChatId: string): Promise<string | undefined> {
    return this.channels.get(externalChatId)?.info.contactId
  }

  override async listGroups(): Promise<GroupSummary[]> {
    return [...this.channels.values()]
      .filter((channel) => channel.info.isGroup)
      .map((channel) => ({
        externalChatId: channel.info.externalChatId,
        title: channel.info.title,
        participantIds: channel.participantIds.filter((id) => id !== this.selfId)
      }))
  }

  private async connect(attempt: number, signal: AbortSignal): Promise<void> {
    try {
      const proxyUrl = normalizeProxyUrl(this.opts.getProxyUrl?.() ?? '')
      this.dispatcher = createRequiredDispatcher(proxyUrl)
      this.log.info('使用账号独立代理连接 KakaoTalk', { proxy: redactProxyUrl(proxyUrl) })

      const identity = await this.ensureIdentity()
      const stored = this.opts.getCredentials() ?? {}
      let credential: AndroidSessionCredential | undefined

      // 用户重新填写密码时主动刷新令牌；正常重启则直接使用上次会话，不保存账号密码。
      if (stored.email?.trim() && stored.password) {
        const email = stored.email.trim()
        const password = stored.password
        // 表单保存后主进程马上把一次性密码从磁盘配置移除；网络请求和手机
        // 设备确认期间只保留在当前调用栈内，失败时也不会残留等待下次启动。
        await this.opts.saveCredentials({
          email,
          deviceUuid: identity.deviceUuid,
          deviceName: identity.deviceName,
          advertisementId: identity.advertisementId
        })
        this.setState('connecting', { detail: '正在验证 Kakao 账号…' })
        credential = await this.authenticate(email, password, identity, signal)
      } else {
        credential = credentialFrom(stored)
      }
      if (!credential) {
        this.setState('need_credentials', {
          detail: '请输入 Kakao 账号（邮箱）和密码；首次登录还需在手机 KakaoTalk 中确认设备验证码。'
        })
        return
      }

      if (attempt !== this.attempt || signal.aborted) return
      await this.closeDispatcher()
      const client = new KakaoLocoClient(KAKAO_CONFIGURATION, {
        publicKey: androidReferenceLocoPublicKeyPem,
        proxyUrl,
        signal
      })
      this.client = client
      client.on('message', (push) => this.handleMessage(push))
      client.on('error', (error) => {
        if (attempt !== this.attempt) return
        this.log.error('KakaoTalk 长连接异常', error)
        this.setState('error', { detail: readableError(error) })
      })
      client.on('close', () => {
        if (attempt !== this.attempt || this.status === 'stopped' || this.status === 'logged_out') return
        if (this.status !== 'error') this.setState('error', { detail: 'KakaoTalk 连接已断开，请重新连接。' })
      })

      const login = await client.connect(credential)
      if (attempt !== this.attempt || signal.aborted) {
        await client.close()
        return
      }
      this.selfId = login.userId.toString()
      this.channels.clear()
      for (const channel of login.channels) this.rememberChannel(channel)

      const email = this.opts.getCredentials()?.email?.trim()
      this.setState('connected', {
        selfName: email ? email.split('@')[0] : 'KakaoTalk',
        detail: `已同步 ${login.channels.length} 个会话`
      })
      this.log.info('KakaoTalk 已连接', { channels: login.channels.length })
    } catch (error) {
      if (attempt !== this.attempt || signal.aborted) return
      this.log.error('KakaoTalk 连接失败', error)
      this.client = undefined
      this.setState('error', { detail: readableError(error) })
    } finally {
      await this.closeDispatcher()
    }
  }

  private async authenticate(
    email: string,
    password: string,
    identity: { deviceUuid: string; deviceName: string; advertisementId: string },
    signal: AbortSignal
  ): Promise<AndroidSessionCredential> {
    const auth = new AndroidAuthClient(
      KAKAO_CONFIGURATION,
      identity,
      legacyAndroidSubXvcProvider,
      { fetchImplementation: this.proxyFetch.bind(this, signal) }
    )
    const result = await auth.authenticate(
      { id: email, password },
      {
        signal,
        deviceOsApiLevel: '35',
        approvalTimeoutSeconds: 180,
        onPasscodeRequired: (challenge) => {
          if (!challenge.passcode) throw new Error('KakaoTalk 未返回设备验证码')
          this.setState('waiting_device_approval', {
            verificationCode: challenge.passcode,
            detail: '请在手机 KakaoTalk 的设备验证页面输入并确认下方 8 位验证码。'
          })
        }
      }
    )
    if (!result.success) throw new Error(authStatusMessage(result.status))

    await this.opts.saveCredentials({
      email,
      deviceUuid: identity.deviceUuid,
      deviceName: identity.deviceName,
      advertisementId: identity.advertisementId,
      userId: result.credential.userId.toString(),
      accessToken: result.credential.accessToken,
      // 只保存会话令牌；不复制 password 或其他未知字段。
      refreshToken: result.credential.refreshToken
    })
    return result.credential
  }

  private async ensureIdentity(): Promise<{ deviceUuid: string; deviceName: string; advertisementId: string }> {
    const current = this.opts.getCredentials() ?? {}
    const fingerprint = this.opts.getFingerprint?.()
    if (!fingerprint) throw new Error('设备指纹未生成，安全隔离已阻止登录')
    const deviceUuid = /^[a-f0-9]{40}$/i.test(current.deviceUuid ?? '')
      ? current.deviceUuid!
      : digest(`${fingerprint.seed}:kakao-device`).slice(0, 40)
    const advertisementId = isUuid(current.advertisementId)
      ? current.advertisementId!
      : deterministicUuid(`${fingerprint.seed}:kakao-advertisement`)
    const deviceName = current.deviceName?.trim() || fingerprint.deviceName
    if (
      current.deviceUuid !== deviceUuid ||
      current.advertisementId !== advertisementId ||
      current.deviceName !== deviceName
    ) {
      await this.opts.saveCredentials({ ...current, deviceUuid, advertisementId, deviceName })
    }
    return { deviceUuid, deviceName, advertisementId }
  }

  private rememberChannel(channel: ChannelDataDocument): void {
    const info = kakaoConversationInfo(channel, this.selfId)
    const participantIds = (channel.i ?? []).map(String)
    this.channels.set(info.externalChatId, { info, participantIds })
    const last = channel.l
    if (last) this.emit('historyMessage', mapKakaoChatlog(last, this.accountId, this.selfId))
    this.emit('conversation', {
      externalChatId: info.externalChatId,
      title: info.title,
      isGroup: info.isGroup,
      contactId: info.contactId,
      lastMessageAt: last ? mapKakaoChatlog(last, this.accountId, this.selfId).timestamp : 0,
      lastMessagePreview: last ? previewOf(kakaoBody(last)) : '',
      unreadCount: Math.max(0, channel.n)
    })
  }

  private handleMessage(push: MessagePush): void {
    if (!push.chatLog) return
    const chatId = locoId(push.chatId)
    const cached = this.channels.get(chatId)
    const authorId = locoId(push.chatLog.authorId)
    let title = cached?.info.title
    let contactId = cached?.info.contactId
    if (!cached?.info.isGroup && authorId !== this.selfId) {
      title = push.authorNickname?.trim() || title
      contactId ??= `kakao:${authorId}`
    }
    if (cached && (title !== cached.info.title || contactId !== cached.info.contactId)) {
      cached.info = { ...cached.info, title: title ?? cached.info.title, contactId }
    }

    this.emit('message', mapKakaoChatlog(push.chatLog, this.accountId, this.selfId, push.authorNickname))
    this.emit('conversation', {
      externalChatId: chatId,
      title,
      isGroup: cached?.info.isGroup ?? false,
      contactId
    })
  }

  private proxyFetch(signal: AbortSignal, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!this.dispatcher) throw new Error('代理链路已断开，安全隔离已阻止直连')
    return fetch(input, withDispatcher({ ...init, signal }, this.dispatcher))
  }

  private requireClient(): KakaoLocoClient {
    if (!this.client?.connected || this.status !== 'connected') {
      throw new Error('KakaoTalk 未连接，无法发送消息')
    }
    return this.client
  }

  private async closeDispatcher(): Promise<void> {
    const dispatcher = this.dispatcher
    this.dispatcher = undefined
    if (dispatcher) await dispatcher.close().catch(() => undefined)
  }

  private setState(
    status: ChannelStatus,
    extra: { detail?: string; verificationCode?: string; selfName?: string } = {}
  ): void {
    this.status = status
    this.emit('state', this.makeState({ status, ...extra }))
  }
}

function credentialFrom(credentials: Record<string, string>): AndroidSessionCredential | undefined {
  const { userId, accessToken, deviceUuid } = credentials
  if (!/^\d+$/.test(userId ?? '') || !accessToken?.trim() || !/^[a-f0-9]{40}$/i.test(deviceUuid ?? '')) {
    return undefined
  }
  return { userId: Long.fromString(userId!), accessToken: accessToken!.trim(), deviceUuid: deviceUuid! }
}

function authStatusMessage(status: number): string {
  const known: Record<number, string> = {
    12: 'Kakao 密码不正确',
    13: 'Kakao 登录尝试过多，请稍后再试',
    16: 'Kakao 账号不存在',
    26: 'Kakao 账号处于休眠状态，请先在官方客户端恢复',
    27: 'Kakao 账号受限，请先在官方客户端处理',
    30: 'Kakao 登录失败，请检查账号和密码',
    31: 'Kakao 邮箱尚未验证',
    '-20': 'Kakao 今日登录请求过多，请明天再试',
    '-30': 'Kakao 请求过于频繁，请稍后再试',
    '-31': 'Kakao 设备验证码不匹配',
    '-102': 'Kakao 设备注册失败',
    '-110': 'Kakao 设备注册无效，请删除账号后重新添加',
    '-111': 'Kakao 设备验证码无效',
    '-112': 'Kakao 无法生成设备验证码',
    '-126': '请先在手机 KakaoTalk 同意最新条款',
    '-132': 'Kakao 拒绝了当前子设备类型',
    '-997': 'Kakao 账号已被限制',
    '-999': 'KakaoTalk 协议版本需要升级'
  }
  return known[status] ?? `KakaoTalk 登录失败（状态码 ${status}）`
}

function readableError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as Error & { cause?: unknown }).cause
  if (cause instanceof Error && cause.message) return `${error.message}：${cause.message}`
  return error.message
}

function isUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function deterministicUuid(value: string): string {
  const hex = digest(value).slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = '8'
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}
