export const PROXY_PROTOCOL_OPTIONS = ['socks5', 'socks4', 'http', 'https'] as const

export type ProxyProtocol = (typeof PROXY_PROTOCOL_OPTIONS)[number]

export interface ProxyInputDraft {
  protocol: ProxyProtocol
  address: string
}
const EXPLICIT_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i

function supportedProtocol(value: string): ProxyProtocol | undefined {
  const protocol = value.toLowerCase() === 'socks' ? 'socks5' : value.toLowerCase()
  return (PROXY_PROTOCOL_OPTIONS as readonly string[]).includes(protocol)
    ? protocol as ProxyProtocol
    : undefined
}

/** 把已保存的标准 URL 拆成“协议下拉 + 地址”，无协议输入默认使用 SOCKS5。 */
export function splitProxyInput(
  raw: string | undefined,
  fallback: ProxyProtocol = 'socks5'
): ProxyInputDraft {
  const value = raw?.trim() ?? ''
  const match = value.match(EXPLICIT_SCHEME)
  if (!match) return { protocol: fallback, address: value }
  const protocol = supportedProtocol(match[1] ?? '')
  if (!protocol) return { protocol: fallback, address: value }
  return { protocol, address: value.slice(match[0].length) }
}

/**
 * 组合成底层使用的标准代理 URL，并兼容代理商常见的四段格式：
 * `IP:端口:账号:密码` → `socks5://账号:密码@IP:端口`。
 */
export function composeProxyUrl(protocol: ProxyProtocol, rawAddress: string): string {
  let address = rawAddress.trim()
  if (!address) return ''

  const explicit = address.match(EXPLICIT_SCHEME)
  if (explicit) {
    const pastedProtocol = supportedProtocol(explicit[1] ?? '')
    // 不支持的显式协议原样交给主进程，保留准确的“不支持该协议”错误。
    if (!pastedProtocol) return address
    protocol = pastedProtocol
    address = address.slice(explicit[0].length)
  }

  // host:port:user:password 是多数代理商直接提供的复制格式。密码允许包含冒号；
  // 账号密码在这里做 URL 编码，避免 @、# 等字符改变 URL 结构。
  const quartet = address.match(/^(\[[^\]]+\]|[^:/@\s]+):(\d{1,5}):([^:\s]+):(.+)$/)
  if (quartet) {
    const [, host, port, username, password] = quartet
    address = `${encodeURIComponent(username!)}:${encodeURIComponent(password!)}@${host}:${port}`
  }

  return `${protocol}://${address}`
}
