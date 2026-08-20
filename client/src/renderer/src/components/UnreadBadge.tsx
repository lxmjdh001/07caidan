/**
 * 未读角标。
 *
 * 统一封装是为了两件事：数字上限和「有未读但不计数」的圆点形态。
 * 打粉客服一个号挂几百个会话，真出现 4 位数时角标会把整行撑变形，
 * 所以超过 99 一律显示 99+ —— 超过这个量级具体数字对操作没有意义。
 */
export function UnreadBadge({
  count,
  /** 只显示圆点不显示数字（用于「有动静但不必强调数量」的场景） */
  dot
}: {
  count: number
  dot?: boolean
}): React.JSX.Element | null {
  // 用 !(count > 0) 而非 count <= 0：NaN/undefined 的比较恒为 false，会让脏数据渲染成 NaN 角标
  if (!(count > 0)) return null
  if (dot) return <span className="unread-dot" aria-label={`${count}`} />
  return <span className="unread-badge">{count > 99 ? '99+' : count}</span>
}
