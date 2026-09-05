export type ProxyVendorRegion = 'global' | 'china'

/** 服务器下发的代理供应商展示卡片，不包含代理账号、密码或任何客户数据。 */
export interface ProxyVendor {
  id: string
  name: string
  region: ProxyVendorRegion
  summary: string
  purchaseUrl: string
  logoUrl: string
  badge: string
  buttonLabel: string
  enabled: boolean
  recommended: boolean
  sortOrder: number
  createdAt: number
  updatedAt: number
}
