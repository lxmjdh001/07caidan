/**
 * 品牌信息（白牌）。构建时由 electron-vite 的 define 注入
 * `__BRAND__`（来自仓库根 branding/<BRAND>.json）。
 *
 * 测试环境（vitest）没有 define，回落默认值 —— 品牌只影响展示，
 * 不该让任何单测依赖它。
 */
export interface Brand {
  appName: string
  shortName: string
  logoText: string
  company: string
  website: string
  supportEmail: string
  themeColor: string
  dashboardTitle: string
}

declare const __BRAND__: Brand | undefined

const FALLBACK: Brand = {
  appName: 'OmniChat',
  shortName: 'omnichat',
  logoText: 'OC',
  company: 'OmniChat',
  website: '',
  supportEmail: '',
  themeColor: '#22a06b',
  dashboardTitle: '引流看板'
}

export const brand: Brand =
  typeof __BRAND__ !== 'undefined' && __BRAND__ ? { ...FALLBACK, ...__BRAND__ } : FALLBACK
