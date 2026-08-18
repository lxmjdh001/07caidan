/** 品牌主题色 → UI 强调色（--accent / --accent-soft）。仅对自定义品牌生效。 */
const DEFAULT_ACCENT = '#22a06b'

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

/**
 * 计算要覆盖的强调色 CSS 变量。纯函数，便于测试。
 * 返回 null 表示不覆盖（默认绿或非法色 → 保持各自浅/深调优值）。
 */
export function accentVars(themeColor: string | undefined): { accent: string; accentSoft: string } | null {
  if (!themeColor || themeColor.trim().toLowerCase() === DEFAULT_ACCENT) return null
  const rgb = hexToRgb(themeColor)
  if (!rgb) return null
  return { accent: themeColor, accentSoft: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.13)` }
}

/** 把品牌 themeColor 应用为强调色（--accent-soft 用半透明 tint，浅深主题都适用）。 */
export function applyBrandAccent(themeColor: string | undefined): void {
  const vars = accentVars(themeColor)
  if (!vars) return
  const root = document.documentElement
  root.style.setProperty('--accent', vars.accent)
  root.style.setProperty('--accent-soft', vars.accentSoft)
}
