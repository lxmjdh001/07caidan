import type { ChannelStatus } from '@shared/domain'

/**
 * 这些状态都属于仍在进行中的登录流程，主内容区必须持续展示登录面板。
 * 尤其 Telegram 扫码后可能进入 waiting_password；若这里只识别 waiting_qr，
 * 二维码一消失就会错误地露出空聊天页，让用户误以为已经登录成功。
 */
const LOGIN_PANEL_STATUSES = new Set<ChannelStatus>([
  'connecting',
  'waiting_qr',
  'waiting_phone',
  'waiting_code',
  'waiting_password',
  'waiting_pairing_code',
  'waiting_device_approval'
])

export function shouldShowLoginPanel(status?: ChannelStatus): boolean {
  return status !== undefined && LOGIN_PANEL_STATUSES.has(status)
}
