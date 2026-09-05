import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { createConnection, type Socket } from 'node:net'
import { connect as connectTls, type TLSSocket } from 'node:tls'
import type { KeyLike } from 'node:crypto'
import { Long } from 'bson'
import { SocksClient } from 'socks'
import { BsonPayloadCodec, type LocoPacket } from '@lukim9-kakao/protocol-core'
import type { AndroidReferenceCommands, MessagePush } from '@lukim9-kakao/protocol-android'
import {
  LocoSecureTransport,
  type LocoSession,
  type ByteTransport
} from '@lukim9-kakao/transport-node'
import {
  AndroidChannelSession,
  AndroidMessageIdSequence,
  AndroidReferenceBootstrap,
  createAndroidReferenceSession,
  type AndroidClientConfiguration,
  type AndroidLoginCursor,
  type AndroidLoginResult,
  type AndroidSessionCredential
} from '@lukim9-kakao/client-android'

const CONNECT_TIMEOUT_MS = 20_000

export interface KakaoLocoClientOptions {
  publicKey: KeyLike
  proxyUrl?: string
  bookingHost?: string
  bookingPort?: number
  pingIntervalMs?: number
  signal?: AbortSignal
}

interface KakaoLocoClientEvents {
  message: [MessagePush, LocoPacket]
  error: [Error]
  close: []
}

/**
 * node-kakao 的高层客户端固定直连。这里用同一套公开协议组件重组最小连接层，
 * 让 booking、checkin 与长连接都真正经过当前账号的 SOCKS/HTTP CONNECT 代理。
 */
export class KakaoLocoClient extends EventEmitter {
  private session: LocoSession<AndroidReferenceCommands> | undefined
  private consumeTask: Promise<void> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private readonly messageIds = new AndroidMessageIdSequence()
  private readonly bookingHost: string
  private readonly bookingPort: number

  constructor(
    private readonly configuration: AndroidClientConfiguration,
    private readonly options: KakaoLocoClientOptions
  ) {
    super()
    this.bookingHost = options.bookingHost ?? 'booking-loco.kakao.com'
    this.bookingPort = options.bookingPort ?? 443
  }

  get connected(): boolean {
    return this.session !== undefined
  }

  async connect(
    credential: AndroidSessionCredential,
    cursor: AndroidLoginCursor = {}
  ): Promise<AndroidLoginResult> {
    if (this.session) throw new Error('KakaoTalk 已连接')
    const bootstrap = new AndroidReferenceBootstrap(this.configuration)
    const endpoint = await this.resolveLoginEndpoint(bootstrap, credential.userId)
    const tcp = await this.openTcp(endpoint.host, endpoint.port)
    const secure = new LocoSecureTransport(tcp, { publicKey: this.options.publicKey })
    const session = createAndroidReferenceSession(secure, { validate: false })
    this.session = session

    try {
      const result = await bootstrap.login(session, credential, cursor)
      this.consumeTask = this.consumePushes(session)
      this.startKeepAlive(session)
      return result
    } catch (error) {
      if (this.session === session) this.session = undefined
      await session.close().catch(() => undefined)
      throw error
    }
  }

  channel(channelId: Long): AndroidChannelSession {
    if (!this.session) throw new Error('KakaoTalk 未连接')
    return new AndroidChannelSession(this.session, channelId, this.messageIds)
  }

  async close(): Promise<void> {
    const session = this.session
    this.session = undefined
    this.stopKeepAlive()
    if (session) await session.close().catch(() => undefined)
    await this.consumeTask?.catch(() => undefined)
    this.consumeTask = undefined
  }

  override on<K extends keyof KakaoLocoClientEvents>(
    event: K,
    listener: (...args: KakaoLocoClientEvents[K]) => void
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  private async resolveLoginEndpoint(
    bootstrap: AndroidReferenceBootstrap,
    userId: Long | number
  ): Promise<{ host: string; port: number }> {
    const bookingTransport = await this.openTls(this.bookingHost, this.bookingPort)
    const bookingSession = createAndroidReferenceSession(bookingTransport, { validate: false })
    let checkinHost: string
    let checkinPort: number
    try {
      const network = await bootstrap.getConfiguration(bookingSession)
      const host = network.ticket.lsl[0]
      const port = network.wifi.ports[0]
      if (!host || !port) throw new Error('KakaoTalk 未返回 checkin 节点')
      checkinHost = host
      checkinPort = port
    } finally {
      await bookingSession.close().catch(() => undefined)
    }

    const checkinTcp = await this.openTcp(checkinHost, checkinPort)
    const checkinSecure = new LocoSecureTransport(checkinTcp, { publicKey: this.options.publicKey })
    const checkinSession = createAndroidReferenceSession(checkinSecure, { validate: false })
    try {
      const response = await bootstrap.checkin(checkinSession, userId)
      if (!response.host || !response.port) throw new Error('KakaoTalk 未返回登录节点')
      return { host: response.host, port: response.port }
    } finally {
      await checkinSession.close().catch(() => undefined)
    }
  }

  private async consumePushes(session: LocoSession<AndroidReferenceCommands>): Promise<void> {
    const codec = new BsonPayloadCodec()
    try {
      for await (const packet of session.pushes()) {
        if (packet.header.method !== 'MSG') continue
        const decoded = codec.decode(packet.dataType, packet.payload) as MessagePush
        this.emit('message', decoded, packet)
      }
    } catch (error) {
      if (this.session === session) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)))
      }
    } finally {
      if (this.session === session) {
        this.session = undefined
        this.stopKeepAlive()
        this.emit('close')
      }
    }
  }

  private startKeepAlive(session: LocoSession<AndroidReferenceCommands>): void {
    const interval = this.options.pingIntervalMs ?? 30_000
    if (interval <= 0) return
    this.pingTimer = setInterval(() => {
      if (this.session !== session) return
      void session.request('PING', {}, { timeoutMs: 10_000 }).catch(() => undefined)
    }, interval)
  }

  private stopKeepAlive(): void {
    if (!this.pingTimer) return
    clearInterval(this.pingTimer)
    this.pingTimer = undefined
  }

  private async openTcp(host: string, port: number): Promise<ByteTransport> {
    const socket = await openKakaoProxySocket(this.options.proxyUrl, host, port, this.options.signal)
    return new SocketTransport(socket)
  }

  private async openTls(host: string, port: number): Promise<ByteTransport> {
    const socket = await openKakaoProxySocket(this.options.proxyUrl, host, port, this.options.signal)
    const tls = connectTls({ socket, servername: host })
    await waitForSocket(tls, 'secureConnect', this.options.signal)
    return new SocketTransport(tls)
  }
}

/** ByteTransport 的 socket 包装；依赖包把同类构造器设成 protected，无法注入代理 socket。 */
class SocketTransport implements ByteTransport {
  readonly readable: AsyncIterable<Uint8Array>
  private closeTask: Promise<void> | undefined

  constructor(private readonly socket: Socket | TLSSocket) {
    this.readable = this.readSocket()
  }

  async write(data: Uint8Array, options?: { readonly signal?: AbortSignal }): Promise<void> {
    if (options?.signal?.aborted) throw abortError(options.signal)
    const copy = data.slice()
    await new Promise<void>((resolve, reject) => {
      const signal = options?.signal
      const onAbort = (): void => reject(abortError(signal))
      signal?.addEventListener('abort', onAbort, { once: true })
      this.socket.write(copy, (error) => {
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.closeTask = new Promise((resolve) => {
      if (this.socket.destroyed) {
        resolve()
        return
      }
      this.socket.once('close', resolve)
      this.socket.destroy()
    })
    return this.closeTask
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private async *readSocket(): AsyncIterable<Uint8Array> {
    for await (const chunk of this.socket) {
      if (!(chunk instanceof Uint8Array)) throw new Error('KakaoTalk socket 返回了非字节数据')
      yield chunk.slice()
    }
  }
}

export async function openKakaoProxySocket(
  proxyUrl: string | undefined,
  host: string,
  port: number,
  signal?: AbortSignal
): Promise<Socket> {
  const raw = proxyUrl?.trim()
  if (!raw) {
    throw new Error('代理链路未配置，安全隔离已阻止 KakaoTalk 直连')
  }

  let proxy: URL
  try {
    proxy = new URL(raw)
  } catch {
    throw new Error(`代理地址格式非法: ${raw}`)
  }
  if (!proxy.hostname || !proxy.port) throw new Error(`代理地址缺少主机或端口: ${raw}`)
  if (proxy.protocol.startsWith('socks')) return openSocksSocket(proxy, host, port, signal)
  if (proxy.protocol === 'http:' || proxy.protocol === 'https:') {
    return openHttpTunnel(proxy, host, port, signal)
  }
  throw new Error(`不支持的代理协议: ${proxy.protocol.replace(':', '')}`)
}

async function openSocksSocket(
  proxy: URL,
  host: string,
  port: number,
  signal?: AbortSignal
): Promise<Socket> {
  const task = SocksClient.createConnection({
    proxy: {
      host: proxy.hostname,
      port: Number(proxy.port),
      type: proxy.protocol === 'socks4:' ? 4 : 5,
      userId: proxy.username ? decodeURIComponent(proxy.username) : undefined,
      password: proxy.password ? decodeURIComponent(proxy.password) : undefined
    },
    command: 'connect',
    destination: { host, port },
    timeout: CONNECT_TIMEOUT_MS
  }).then(({ socket }) => socket)
  return abortableSocket(task, signal)
}

async function openHttpTunnel(
  proxy: URL,
  host: string,
  port: number,
  signal?: AbortSignal
): Promise<Socket> {
  const proxyPort = Number(proxy.port)
  let socket: Socket | TLSSocket
  if (proxy.protocol === 'https:') {
    const tls = connectTls({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
    await waitForSocket(tls, 'secureConnect', signal)
    socket = tls
  } else {
    const tcp = createConnection({ host: proxy.hostname, port: proxyPort })
    await waitForSocket(tcp, 'connect', signal)
    socket = tcp
  }

  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
  const headers = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    'Proxy-Connection: Keep-Alive'
  ]
  if (proxy.username || proxy.password) {
    const username = decodeURIComponent(proxy.username)
    const password = decodeURIComponent(proxy.password)
    headers.push(`Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`)
  }
  socket.write(`${headers.join('\r\n')}\r\n\r\n`)
  await waitForConnectResponse(socket, signal)
  return socket as Socket
}

function waitForConnectResponse(socket: Socket | TLSSocket, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0)
    const timer = setTimeout(() => finish(new Error('HTTP 代理 CONNECT 超时')), CONNECT_TIMEOUT_MS)
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf('\r\n\r\n')
      if (end < 0) {
        if (received.length > 64 * 1024) finish(new Error('HTTP 代理响应头过大'))
        return
      }
      const head = received.subarray(0, end).toString('latin1')
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(head)
      if (!match || match[1] !== '200') {
        finish(new Error(`HTTP 代理 CONNECT 失败${match ? ` (${match[1]})` : ''}`))
        return
      }
      const rest = received.subarray(end + 4)
      cleanup()
      if (rest.length > 0) socket.unshift(rest)
      resolve()
    }
    const onError = (error: Error): void => finish(error)
    const onAbort = (): void => finish(abortError(signal))
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (error: Error): void => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function waitForSocket(
  socket: Socket | TLSSocket,
  event: 'connect' | 'secureConnect',
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('KakaoTalk 网络连接超时')), CONNECT_TIMEOUT_MS)
    const onReady = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => finish(error)
    const onAbort = (): void => finish(abortError(signal))
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off(event, onReady)
      socket.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (error: Error): void => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    socket.once(event, onReady)
    socket.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function abortableSocket(task: Promise<Socket>, signal?: AbortSignal): Promise<Socket> {
  if (!signal) return task
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      reject(abortError(signal))
      void task.then((socket) => socket.destroy()).catch(() => undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void task.then(
      (socket) => {
        if (settled) {
          socket.destroy()
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(socket)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('KakaoTalk 连接已取消')
}
