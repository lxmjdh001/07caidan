import type { ChannelKind } from '@shared/domain'

interface Meta {
  label: string
  color: string
  icon: React.JSX.Element
}

const WA_ICON = (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden>
    <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.3 14.1c-.2.6-1.2 1.2-1.7 1.2-.4 0-1 .2-3-.7a10.5 10.5 0 0 1-4.3-3.8c-.2-.2-1-1.4-1-2.6s.6-1.8.9-2.1c.2-.2.5-.3.6-.3h.5c.2 0 .4 0 .5.4l.7 1.7c.1.2 0 .4-.1.5l-.5.6c-.1.1-.2.3-.1.5.2.4 1 1.8 2 2.3.3.2.5.2.6 0l.7-.9c.1-.2.3-.2.5-.1l1.5.7.4.2s.1.6-.2 1.3Z" />
  </svg>
)

const TG_ICON = (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden>
    <path d="M21.9 4.6c.3-1.1-.8-2-1.8-1.6L2.7 9.7c-1.1.4-1.1 2 .1 2.3l4.4 1.3 1.7 5.4c.3 1 1.6 1.3 2.3.5l2.4-2.5 4.5 3.3c.9.7 2.2.2 2.4-.9l3.4-14.5Z" />
  </svg>
)

const LINE_ICON = (
  <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden>
    <path d="M12 3C6.5 3 2 6.6 2 11.1c0 4 3.6 7.4 8.4 8 .3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c0 .3-.2 1 .9.6 1.1-.5 6-3.5 8.2-6C21.7 14.4 22 12.8 22 11c0-4.4-4.5-8-10-8Z" />
  </svg>
)

const META: Record<ChannelKind, Meta> = {
  whatsapp: { label: 'WhatsApp', color: '#22a06b', icon: WA_ICON },
  telegram: { label: 'Telegram', color: '#2aabee', icon: TG_ICON },
  line: { label: 'LINE', color: '#06c755', icon: LINE_ICON }
}

/** 平台标签（图标 + 品牌色），紧凑模式只显示图标 */
export function ChannelTag({
  kind,
  compact
}: {
  kind: ChannelKind
  compact?: boolean
}): React.JSX.Element {
  const m = META[kind]
  return (
    <span
      className={`channel-tag ${compact ? 'compact' : ''}`}
      style={{ color: m.color, background: `${m.color}1a` }}
      title={m.label}
    >
      {m.icon}
      {!compact && <span className="channel-tag-label">{m.label}</span>}
    </span>
  )
}

/** 账号标签（备注名/昵称） */
export function AccountTag({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="account-tag" title={label}>
      <span className="account-tag-at">@</span>
      <span className="account-tag-name">{label}</span>
    </span>
  )
}
