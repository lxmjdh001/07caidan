/** 品牌信息；构建时由 vite define 注入，来自仓库根 branding/<BRAND>.json */
export interface Brand {
  appName: string
  logoText: string
  themeColor?: string
}

declare const __BRAND__: Brand | undefined

const FALLBACK: Brand = { appName: 'OmniChat', logoText: 'OC', themeColor: '#22a06b' }

export const brand: Brand =
  typeof __BRAND__ !== 'undefined' && __BRAND__ ? { ...FALLBACK, ...__BRAND__ } : FALLBACK

/** 品牌主题色 → 强调色（--accent/--accent-soft）；默认绿保持调优值不覆盖 */
export function applyBrandAccent(themeColor: string | undefined): void {
  if (!themeColor || themeColor.toLowerCase() === '#22a06b') return
  let h = themeColor.trim().replace(/^#/, '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const root = document.documentElement
  root.style.setProperty('--accent', themeColor)
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.13)`)
}
