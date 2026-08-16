export const CHANNELS: Record<string, { label: string; cls: string }> = {
  whatsapp: { label: 'WhatsApp', cls: 'wa' },
  telegram: { label: 'Telegram', cls: 'tg' },
  line: { label: 'LINE', cls: 'line' }
}

const COLORS = ['#4f9cf9', '#22a06b', '#e8833a', '#9a6ff0', '#e5588c', '#2fb5b5']

export function avatarColor(s: string): string {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
  return COLORS[Math.abs(h) % COLORS.length]!
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export const INTENT_LABEL: Record<string, string> = {
  high: '高意向',
  medium: '中意向',
  low: '低意向',
  unknown: '未知'
}
