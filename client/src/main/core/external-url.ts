const SAFE_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])

/** 主窗口只允许把明确的网页/邮件链接交给操作系统，拒绝 file、shell 等本地协议。 */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    return SAFE_EXTERNAL_PROTOCOLS.has(new URL(raw).protocol.toLowerCase())
  } catch {
    return false
  }
}
