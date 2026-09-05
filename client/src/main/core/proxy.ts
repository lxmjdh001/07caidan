import type { Agent } from 'node:https'
import { createHash } from 'node:crypto'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksClient } from 'socks'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { Agent as UndiciAgent, ProxyAgent, buildConnector, type Dispatcher } from 'undici'
import { composeProxyUrl } from '@shared/proxy-input'

/** 低层代理解析器；业务连接必须使用 createRequired* 工厂，禁止直连回退。 */
/** GramJS 的 SOCKS 代理配置（MTProto 连接层使用，与 http Agent 不同） */
export interface SocksProxyConfig {
  ip: string
  port: number
  socksType: 4 | 5
  username?: string
  password?: string
}

const PROXY_PROTOCOLS = new Set(['socks:', 'socks4:', 'socks5:', 'http:', 'https:'])

/** 严格解析并规范化代理地址；不接受路径、查询参数或缺少端口的模糊配置。 */
export function normalizeProxyUrl(raw: string): string {
  const value = composeProxyUrl('socks5', raw)
  if (!value) throw new Error('必须先配置独立代理，系统不会回落到本机直连')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('代理地址格式非法，请填写 IP:端口 或完整代理 URL')
  }
  if (!PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`不支持的代理协议: ${parsed.protocol.replace(':', '')}（支持 socks4/socks5/http/https）`)
  }
  if (!parsed.hostname) throw new Error('代理地址缺少主机')
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('代理地址不能包含路径、查询参数或片段')
  }
  const port = parsed.port || (parsed.protocol === 'http:' ? '80' : parsed.protocol === 'https:' ? '443' : '')
  if (!port) throw new Error('代理地址缺少端口')
  const portNumber = Number(port)
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new Error('代理端口必须在 1-65535 之间')
  }
  const username = parsed.username ? encodeURIComponent(decodeURIComponent(parsed.username)) : ''
  const password = parsed.password ? encodeURIComponent(decodeURIComponent(parsed.password)) : ''
  const auth = username ? `${username}${password ? `:${password}` : ''}@` : ''
  return `${parsed.protocol}//${auth}${parsed.hostname}:${portNumber}`
}

/** Telegram MTProto 当前只接受 SOCKS；拒绝而不是静默改成本机直连。 */
export function normalizeProxyForAccount(accountKey: string, raw: string): string {
  const normalized = normalizeProxyUrl(raw)
  if (accountKey.startsWith('telegram:') && !normalized.startsWith('socks')) {
    throw new Error('Telegram 普通账号仅支持 SOCKS4/SOCKS5 代理，不能使用 HTTP 代理')
  }
  return normalized
}

export function proxyHash(proxyUrl: string): string {
  return createHash('sha256').update(normalizeProxyUrl(proxyUrl)).digest('hex')
}

/** 日志与界面状态里永远不返回代理账号密码。 */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl)
    const hasAuth = Boolean(parsed.username || parsed.password)
    parsed.username = ''
    parsed.password = ''
    const rendered = parsed.toString().replace(/\/$/, '')
    return hasAuth ? rendered.replace('://', '://***@') : rendered
  } catch {
    return '[invalid proxy]'
  }
}

/**
 * 把账号配置里的代理地址解析成 GramJS 需要的 SOCKS 配置。
 * GramJS 的 MTProto 连接只支持 SOCKS4/5 与 MTProxy，不支持 http 代理。
 */
export function createSocksProxyConfig(proxyUrl: string | undefined): SocksProxyConfig | undefined {
  const url = proxyUrl?.trim()
  if (!url) return undefined

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('代理地址格式非法')
  }

  const protocol = parsed.protocol.replace(':', '')
  if (!protocol.startsWith('socks')) return undefined
  if (!parsed.hostname || !parsed.port) throw new Error('代理地址缺少主机或端口')

  return {
    ip: parsed.hostname,
    port: Number(parsed.port),
    socksType: protocol === 'socks4' ? 4 : 5,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined
  }
}

export function createRequiredSocksProxyConfig(proxyUrl: string | undefined): SocksProxyConfig {
  if (!proxyUrl?.trim()) throw new Error('代理未配置，安全隔离已阻止直连')
  const config = createSocksProxyConfig(normalizeProxyUrl(proxyUrl))
  if (!config) throw new Error('该连接仅支持 SOCKS4/SOCKS5 代理，安全隔离已阻止直连')
  return config
}

export function createProxyAgent(proxyUrl: string | undefined): Agent | undefined {
  const url = proxyUrl?.trim()
  if (!url) return undefined

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('代理地址格式非法')
  }

  const protocol = parsed.protocol.replace(':', '')
  if (protocol.startsWith('socks')) {
    // 用户界面仍使用常见的 socks4/socks5 写法；底层切换到 4a/5h，
    // 让目标域名由代理端解析，避免检测及平台请求产生本机 DNS 泄漏。
    if (parsed.protocol === 'socks4:') parsed.protocol = 'socks4a:'
    if (parsed.protocol === 'socks5:') parsed.protocol = 'socks5h:'
    return new SocksProxyAgent(parsed) as unknown as Agent
  }
  if (protocol === 'http' || protocol === 'https') {
    return new HttpsProxyAgent(url) as unknown as Agent
  }
  throw new Error(`不支持的代理协议: ${protocol}（支持 socks4/socks5/http/https）`)
}

export function createRequiredProxyAgent(proxyUrl: string | undefined): Agent {
  if (!proxyUrl?.trim()) throw new Error('代理未配置，安全隔离已阻止直连')
  return createProxyAgent(normalizeProxyUrl(proxyUrl))!
}

/**
 * 按代理 URL 创建 undici Dispatcher（供全局 fetch 使用，如 Telegram/LINE 的 HTTP 平台调用）。
 * 与 createProxyAgent（node http Agent，供 Baileys 的 ws 用）区分：
 *   - http/https 代理 → undici ProxyAgent（CONNECT 隧道，支持 https 目标）
 *   - socks4/5 代理 → 自建 Agent，用 socks 拨号后交给 undici 做 TLS 升级
 * 业务连接必须使用 createRequiredDispatcher；此可选工厂仅供解析与单元测试。
 */
export function createDispatcher(proxyUrl: string | undefined): Dispatcher | undefined {
  const url = proxyUrl?.trim()
  if (!url) return undefined

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('代理地址格式非法')
  }

  const protocol = parsed.protocol.replace(':', '')
  if (protocol === 'http' || protocol === 'https') {
    return new ProxyAgent(url)
  }
  if (protocol.startsWith('socks')) {
    return socksDispatcher(parsed)
  }
  throw new Error(`不支持的代理协议: ${protocol}（支持 socks4/socks5/http/https）`)
}

export function createRequiredDispatcher(proxyUrl: string | undefined): Dispatcher {
  if (!proxyUrl?.trim()) throw new Error('代理未配置，安全隔离已阻止直连')
  return createDispatcher(normalizeProxyUrl(proxyUrl))!
}

function socksDispatcher(parsed: URL): Dispatcher {
  if (!parsed.hostname || !parsed.port) {
    throw new Error('代理地址缺少主机或端口')
  }
  const proxy = {
    host: parsed.hostname,
    port: Number(parsed.port),
    type: (parsed.protocol === 'socks4:' ? 4 : 5) as 4 | 5,
    userId: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined
  }
  const tlsUpgrade = buildConnector({})
  return new UndiciAgent({
    connect(opts, callback) {
      const dest = {
        host: (opts as { hostname: string }).hostname,
        port: Number((opts as { port: number | string }).port) ||
          (opts.protocol === 'https:' ? 443 : 80)
      }
      SocksClient.createConnection({ proxy, command: 'connect', destination: dest })
        .then(({ socket }) => {
          if (opts.protocol === 'https:') {
            tlsUpgrade({ ...opts, httpSocket: socket } as never, callback)
          } else {
            callback(null, socket as never)
          }
        })
        .catch((err: unknown) => callback(err as Error, null))
    }
  })
}

/** 给 fetch 的 init 注入 undici dispatcher（dispatcher 非标准 RequestInit 字段，运行时由 Node fetch 识别） */
export function withDispatcher(init: RequestInit, dispatcher: Dispatcher | undefined): RequestInit {
  return dispatcher ? ({ ...init, dispatcher } as RequestInit) : init
}
