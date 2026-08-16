/** 会话列表/消息气泡的时间展示 */

export function formatListTime(ts: number, locale: string, yesterdayLabel: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= startOfToday) {
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  if (ts >= startOfToday - 86_400_000) {
    return yesterdayLabel
  }
  return d.toLocaleDateString(locale, { month: '2-digit', day: '2-digit' })
}

export function formatBubbleTime(ts: number, locale: string): string {
  return new Date(ts).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}
