import type { Agent } from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksClient } from 'socks'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { Agent as UndiciAgent, ProxyAgent, buildConnector, type Dispatcher } from 'undici'

/**
 * 按代理 URL 创建 agent。支持：
 *   socks5://user:pass@host:port  /  socks4://  /  socks://
 *   http://user:pass@host:port    /  https://
 * 返回 undefined 表示不使用代理（走默认网络）。
 */
/** GramJS 的 SOCKS 代理配置（MTProto 连接层使用，与 http Agent 不同） */
export interface SocksProxyConfig {
  ip: string
  port: number
  socksType: 4 | 5
  username?: string
  password?: string
}

/**
 * 把账号配置里的代理地址解析成 GramJS 需要的 SOCKS 配置。
 * GramJS 的 MTProto 连接只支持 SOCKS4/5 与 MTProxy，不支持 http 代理 —— 传 http 时返回 undefined。
 */
export function createSocksProxyConfig(proxyUrl: string | undefined): SocksProxyConfig | undefined {
  const url = proxyUrl?.trim()
  if (!url) return undefined

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`代理地址格式非法: ${url}`)
  }

  const protocol = parsed.protocol.replace(':', '')
  if (!protocol.startsWith('socks')) return undefined
  if (!parsed.hostname || !parsed.port) throw new Error(`代理地址缺少主机或端口: ${url}`)

  return {
    ip: parsed.hostname,
    port: Number(parsed.port),
    socksType: protocol === 'socks4' ? 4 : 5,
    username: parsed.username || undefined,
    password: parsed.password || undefined
  }
}

export function createProxyAgent(proxyUrl: string | undefined): Agent | undefined {
  const url = proxyUrl?.trim()
  if (!url) return undefined

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`代理地址格式非法: ${url}`)
  }

  const protocol = parsed.protocol.replace(':', '')
  if (protocol.startsWith('socks')) {
    return new SocksProxyAgent(url) as unknown as Agent
  }
  if (protocol === 'http' || protocol === 'https') {
    return new HttpsProxyAgent(url) as unknown as Agent
  }
  throw new Error(`不支持的代理协议: ${protocol}（支持 socks4/socks5/http/https）`)
}

/**
 * 按代理 URL 创建 undici Dispatcher（供全局 fetch 使用，如 Telegram/LINE 的 HTTP 平台调用）。
 * 与 createProxyAgent（node http Agent，供 Baileys 的 ws 用）区分：
 *   - http/https 代理 → undici ProxyAgent（CONNECT 隧道，支持 https 目标）
 *   - socks4/5 代理 → 自建 Agent，用 socks 拨号后交给 undici 做 TLS 升级
 * 返回 undefined = 不走代理（默认网络）。
 */
export function createDispatcher(proxyUrl: string | undefined): Dispatcher | undefined {
  const url = proxyUrl?.trim()
  if (!url) return undefined

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`代理地址格式非法: ${url}`)
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

function socksDispatcher(parsed: URL): Dispatcher {
  if (!parsed.hostname || !parsed.port) {
    throw new Error(`代理地址缺少主机或端口: ${parsed.href}`)
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
