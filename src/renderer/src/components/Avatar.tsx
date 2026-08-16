const AVATAR_COLORS = ['#4f9cf9', '#22a06b', '#e8833a', '#9a6ff0', '#e5588c', '#2fb5b5']

function avatarColor(id: string): string {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!
}

interface Props {
  id: string
  title: string
  avatarMediaId?: string
  size?: number
}

/** 会话头像：有图显示图，否则彩色首字母占位 */
export function Avatar({ id, title, avatarMediaId, size = 44 }: Props): React.JSX.Element {
  const style = { width: size, height: size, fontSize: size * 0.38 }
  if (avatarMediaId) {
    return (
      <img
        className="avatar avatar-img"
        style={style}
        src={`omni-media://local/${avatarMediaId}`}
        alt=""
      />
    )
  }
  return (
    <span className="avatar" style={{ ...style, background: avatarColor(id) }}>
      {title.slice(0, 1).toUpperCase()}
    </span>
  )
}
