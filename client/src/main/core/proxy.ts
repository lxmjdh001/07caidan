import type { Agent } from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

/**
 * 按代理 URL 创建 agent。支持：
 *   socks5://user:pass@host:port  /  socks4://  /  socks://
 *   http://user:pass@host:port    /  https://
 * 返回 undefined 表示不使用代理（走默认网络）。
 */
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
