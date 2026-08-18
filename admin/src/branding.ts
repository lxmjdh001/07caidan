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

function expandHex(color: string): string | null {
  let h = color.trim().replace(/^#/, '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  return /^[0-9a-fA-F]{6}$/.test(h) ? h : null
}

/** 生成品牌 favicon（圆角方块 + logoText）的 SVG data-URI */
export function faviconDataUri(logoText: string, themeColor: string): string {
  const t = (logoText || 'OC').slice(0, 2)
  const bg = expandHex(themeColor) ? themeColor : '#22a06b'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/><text x="32" y="43" font-family="system-ui,-apple-system,sans-serif" font-size="30" font-weight="700" fill="#ffffff" text-anchor="middle">${t}</text></svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

/** 设置浏览器标签页 favicon（按品牌，总是设置） */
export function applyBrandFavicon(logoText: string, themeColor: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.type = 'image/svg+xml'
  link.href = faviconDataUri(logoText, themeColor)
}

/** 品牌主题色 → 强调色（--accent/--accent-soft）+ Logo 渐变（--brand-logo）；默认绿保持调优值不覆盖 */
export function applyBrandAccent(themeColor: string | undefined): void {
  if (!themeColor || themeColor.toLowerCase() === '#22a06b') return
  const h = expandHex(themeColor)
  if (!h) return
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const d = { r: Math.round(r * 0.68), g: Math.round(g * 0.68), b: Math.round(b * 0.68) }
  const root = document.documentElement
  root.style.setProperty('--accent', themeColor)
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.13)`)
  root.style.setProperty('--brand-logo', `linear-gradient(135deg, ${themeColor}, rgb(${d.r}, ${d.g}, ${d.b}))`)
}
