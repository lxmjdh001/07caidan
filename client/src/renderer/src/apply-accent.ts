/** 品牌主题色 → UI 强调色（--accent / --accent-soft）与 Logo 渐变（--brand-logo）。 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

export interface AccentVars {
  accent: string
  accentSoft: string
  /** Logo 徽标渐变：品牌色 → 其加深色（135deg），替换默认绿蓝渐变 */
  logoGradient: string
}

/**
 * 计算要覆盖的强调色/Logo CSS 变量。纯函数，便于测试。
 * 返回 null 表示不覆盖（空值或非法色 → 保持当前主题值）。
 */
export function accentVars(themeColor: string | undefined): AccentVars | null {
  if (!themeColor) return null
  const rgb = hexToRgb(themeColor)
  if (!rgb) return null
  const d = { r: Math.round(rgb.r * 0.68), g: Math.round(rgb.g * 0.68), b: Math.round(rgb.b * 0.68) }
  return {
    accent: themeColor,
    accentSoft: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.13)`,
    logoGradient: `linear-gradient(135deg, ${themeColor}, rgb(${d.r}, ${d.g}, ${d.b}))`
  }
}

/** 把品牌 themeColor 应用为强调色与 Logo 渐变。 */
export function applyBrandAccent(themeColor: string | undefined): void {
  const vars = accentVars(themeColor)
  if (!vars) return
  const root = document.documentElement
  root.style.setProperty('--accent', vars.accent)
  root.style.setProperty('--accent-soft', vars.accentSoft)
  root.style.setProperty('--brand-logo', vars.logoGradient)
}
