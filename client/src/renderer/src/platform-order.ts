import type { ChannelKind } from '@shared/domain'

export const DEFAULT_PLATFORM_ORDER: ChannelKind[] = [
  'whatsapp',
  'telegram',
  'telegram_bot',
  'line',
  'kakaotalk',
  'facebook',
  'instagram',
  'tiktok',
  'x',
  'snapchat'
]

/** 升级旧设置时把新平台补到末尾，同时丢弃重复和未知值。 */
export function normalizePlatformOrder(current: readonly ChannelKind[]): ChannelKind[] {
  const known = new Set(DEFAULT_PLATFORM_ORDER)
  const seen = new Set<ChannelKind>()
  const normalized = current.filter((kind) => known.has(kind) && !seen.has(kind) && seen.add(kind))
  for (const kind of DEFAULT_PLATFORM_ORDER) {
    if (!seen.has(kind)) normalized.push(kind)
  }
  return normalized
}

/** 将 source 放到 target 的前面（与界面上的落点指示线一致）。 */
export function reorderPlatformOrder(
  current: ChannelKind[],
  source: ChannelKind,
  target: ChannelKind
): ChannelKind[] {
  if (source === target) return current
  const order = [...current]
  const from = order.indexOf(source)
  const to = order.indexOf(target)
  if (from < 0 || to < 0) return current
  order.splice(from, 1)
  // source 在 target 前方时，移除 source 会令 target 的索引左移一位。
  order.splice(from < to ? to - 1 : to, 0, source)
  return order
}
