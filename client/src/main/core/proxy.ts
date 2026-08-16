import type { Agent } from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

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
