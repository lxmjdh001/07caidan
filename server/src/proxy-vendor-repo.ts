import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Db } from './db.ts'
import { proxyVendors } from './schema.ts'

export const PROXY_VENDOR_REGIONS = ['global', 'china'] as const
export type ProxyVendorRegion = (typeof PROXY_VENDOR_REGIONS)[number]

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

export interface ProxyVendorInput {
  name: string
  region: ProxyVendorRegion
  summary?: string
  purchaseUrl: string
  logoUrl?: string
  badge?: string
  buttonLabel?: string
  enabled?: boolean
  recommended?: boolean
  sortOrder?: number
}

interface ProxyVendorSeed extends ProxyVendorInput {
  seedId: string
}

/** 首次部署提供可编辑的官方站点入口；后台删除后不会在重启时反复生成。 */
export const DEFAULT_PROXY_VENDORS: ProxyVendorInput[] = [
  {
    name: 'NovProxy',
    region: 'global',
    summary: '海外住宅、静态 ISP 与流量型代理服务。',
    purchaseUrl: 'https://novproxy.com/',
    logoUrl: 'https://novproxy.com/static/favicon.ico',
    buttonLabel: '查看官网',
    sortOrder: 10
  },
  {
    name: 'IPIPD',
    region: 'global',
    summary: '覆盖多个国家和地区的静态与动态住宅代理。',
    purchaseUrl: 'https://www.ipipd.com/en-US',
    logoUrl: 'https://www.ipipd.com/favicon.ico',
    buttonLabel: '查看官网',
    sortOrder: 20
  },
  {
    name: 'Helodata',
    region: 'global',
    summary: '住宅、ISP、移动与数据中心代理服务。',
    purchaseUrl: 'https://helodata.com/',
    logoUrl: 'https://helodata.com/icon.png?3c80b83cff86fcd5',
    buttonLabel: '查看官网',
    sortOrder: 30
  },
  {
    name: '易代理 eProxies',
    region: 'global',
    summary: '全球住宅代理与多地区网络资源。',
    purchaseUrl: 'https://www.eproxies.io/zh-cn',
    logoUrl: 'https://www.eproxies.io/favicon.ico',
    buttonLabel: '查看官网',
    sortOrder: 40
  },
  {
    name: '闪臣 HTTP',
    region: 'china',
    summary: '国内 HTTP、HTTPS 与 SOCKS5 代理服务。',
    purchaseUrl: 'https://h.shanchendaili.com/',
    logoUrl: 'https://h.shanchendaili.com/favicon.ico',
    buttonLabel: '查看官网',
    sortOrder: 10
  },
  {
    name: '星空代理',
    region: 'china',
    summary: '国内动态代理与企业代理套餐。',
    purchaseUrl: 'https://www.xkdaili.com/',
    logoUrl: 'https://www.xkdaili.com/favicon.ico',
    buttonLabel: '查看官网',
    sortOrder: 20
  }
]

/**
 * 第二批官方站点入口。
 *
 * 单独使用稳定 seedId，避免已有环境升级时因为数组顺序变化而重复创建；管理员在后台
 * 删除或修改后，启动过程也不会反复覆盖。这里只提供采购导航，不保存供应商账号或密钥。
 */
const DEFAULT_PROXY_VENDORS_V2: ProxyVendorSeed[] = [
  {
    seedId: 'default-global-lajiao-http',
    name: '辣椒 HTTP',
    region: 'global',
    summary: '海外住宅、静态住宅与流量型代理服务。',
    purchaseUrl: 'https://www.lajiaohttp.com/',
    logoUrl: 'https://www.lajiaohttp.com/static/images/favicon.ico',
    buttonLabel: '查看官网',
    sortOrder: 50
  },
  {
    seedId: 'default-global-1024proxy',
    name: '1024proxy',
    region: 'global',
    summary: '动态住宅、静态 ISP 与数据中心代理服务。',
    purchaseUrl: 'https://1024proxy.com/',
    logoUrl: 'https://1024proxy.com/static/img/favicon.ico',
    buttonLabel: '查看官网',
    sortOrder: 60
  },
  {
    seedId: 'default-global-zooproxy',
    name: 'ZooProxy',
    region: 'global',
    summary: '全球住宅、静态住宅与长效 ISP 代理服务。',
    purchaseUrl: 'https://zooproxy.com/',
    logoUrl: 'https://zooproxy.com/static/img/favicon.ico',
    buttonLabel: '查看官网',
    sortOrder: 70
  },
  {
    seedId: 'default-global-rolaproxy',
    name: 'RolaProxy',
    region: 'global',
    summary: '全球动态住宅与静态 ISP 代理服务。',
    purchaseUrl: 'https://www.rolaproxy.com/',
    logoUrl: 'https://www.rolaproxy.com/favicon.ico?v=2',
    buttonLabel: '查看官网',
    sortOrder: 80
  },
  {
    seedId: 'default-china-kuaidaili',
    name: '快代理',
    region: 'china',
    summary: '国内 HTTP、SOCKS、隧道与独享代理服务。',
    purchaseUrl: 'https://www.kuaidaili.com/',
    logoUrl: '',
    buttonLabel: '查看官网',
    sortOrder: 30
  },
  {
    seedId: 'default-china-hshttp',
    name: '花生 HTTP',
    region: 'china',
    summary: '国内 HTTP、HTTPS 与 SOCKS5 动态代理服务。',
    purchaseUrl: 'https://www.hshttp.com/',
    logoUrl: 'https://www.hshttp.com/favicon.ico',
    buttonLabel: '查看官网',
    sortOrder: 40
  }
]

export function isProxyVendorRegion(value: unknown): value is ProxyVendorRegion {
  return typeof value === 'string' && (PROXY_VENDOR_REGIONS as readonly string[]).includes(value)
}

export class ProxyVendorRepo {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  seedDefaults(tenant: string): void {
    for (const [index, input] of DEFAULT_PROXY_VENDORS.entries()) {
      const now = Date.now() + index
      this.db.insert(proxyVendors).values({
        tenant,
        id: `default-${input.region}-${index + 1}`,
        name: input.name,
        region: input.region,
        summary: input.summary ?? '',
        purchaseUrl: input.purchaseUrl,
        logoUrl: input.logoUrl ?? '',
        badge: input.badge ?? '',
        buttonLabel: input.buttonLabel ?? '立即访问',
        enabled: input.enabled === false ? 0 : 1,
        recommended: input.recommended ? 1 : 0,
        sortOrder: input.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now
      }).onConflictDoNothing().run()
    }
  }

  seedDefaultsV2(tenant: string): void {
    for (const [index, input] of DEFAULT_PROXY_VENDORS_V2.entries()) {
      const now = Date.now() + index
      this.db.insert(proxyVendors).values({
        tenant,
        id: input.seedId,
        name: input.name,
        region: input.region,
        summary: input.summary ?? '',
        purchaseUrl: input.purchaseUrl,
        logoUrl: input.logoUrl ?? '',
        badge: input.badge ?? '',
        buttonLabel: input.buttonLabel ?? '立即访问',
        enabled: input.enabled === false ? 0 : 1,
        recommended: input.recommended ? 1 : 0,
        sortOrder: input.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now
      }).onConflictDoNothing().run()
    }
  }

  list(tenant: string, options: { enabledOnly?: boolean; region?: ProxyVendorRegion } = {}): ProxyVendor[] {
    const conditions = [eq(proxyVendors.tenant, tenant)]
    if (options.enabledOnly) conditions.push(eq(proxyVendors.enabled, 1))
    if (options.region) conditions.push(eq(proxyVendors.region, options.region))
    return this.db.select().from(proxyVendors)
      .where(and(...conditions))
      .orderBy(proxyVendors.sortOrder, proxyVendors.createdAt)
      .all()
      .map(toProxyVendor)
  }

  create(tenant: string, input: ProxyVendorInput): ProxyVendor {
    const now = Date.now()
    const row = {
      tenant,
      id: randomUUID(),
      name: input.name,
      region: input.region,
      summary: input.summary ?? '',
      purchaseUrl: input.purchaseUrl,
      logoUrl: input.logoUrl ?? '',
      badge: input.badge ?? '',
      buttonLabel: input.buttonLabel ?? '立即访问',
      enabled: input.enabled === false ? 0 : 1,
      recommended: input.recommended ? 1 : 0,
      sortOrder: input.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now
    }
    this.db.insert(proxyVendors).values(row).run()
    return toProxyVendor(row as typeof proxyVendors.$inferSelect)
  }

  update(tenant: string, id: string, patch: Partial<ProxyVendorInput>): boolean {
    const set: Record<string, unknown> = { updatedAt: Date.now() }
    if (patch.name !== undefined) set.name = patch.name
    if (patch.region !== undefined) set.region = patch.region
    if (patch.summary !== undefined) set.summary = patch.summary
    if (patch.purchaseUrl !== undefined) set.purchaseUrl = patch.purchaseUrl
    if (patch.logoUrl !== undefined) set.logoUrl = patch.logoUrl
    if (patch.badge !== undefined) set.badge = patch.badge
    if (patch.buttonLabel !== undefined) set.buttonLabel = patch.buttonLabel
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
    if (patch.recommended !== undefined) set.recommended = patch.recommended ? 1 : 0
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder
    return this.db.update(proxyVendors).set(set)
      .where(and(eq(proxyVendors.tenant, tenant), eq(proxyVendors.id, id)))
      .run().changes > 0
  }

  delete(tenant: string, id: string): boolean {
    return this.db.delete(proxyVendors)
      .where(and(eq(proxyVendors.tenant, tenant), eq(proxyVendors.id, id)))
      .run().changes > 0
  }
}

function toProxyVendor(row: typeof proxyVendors.$inferSelect): ProxyVendor {
  return {
    id: row.id,
    name: row.name,
    region: row.region as ProxyVendorRegion,
    summary: row.summary,
    purchaseUrl: row.purchaseUrl,
    logoUrl: row.logoUrl,
    badge: row.badge,
    buttonLabel: row.buttonLabel,
    enabled: row.enabled === 1,
    recommended: row.recommended === 1,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
