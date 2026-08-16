/** 品牌信息；构建时由 vite define 注入，来自仓库根 branding/<BRAND>.json */
export interface Brand {
  appName: string
  logoText: string
}

declare const __BRAND__: Brand | undefined

const FALLBACK: Brand = { appName: 'OmniChat', logoText: 'OC' }

export const brand: Brand =
  typeof __BRAND__ !== 'undefined' && __BRAND__ ? { ...FALLBACK, ...__BRAND__ } : FALLBACK
