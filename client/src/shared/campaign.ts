/**
 * 工单（引流任务）与重粉库的共享类型，与 server 端保持一致。
 *
 * ⚠️ 统计结构里刻意不含任何客户标识、昵称、聊天内容 —— 工单看板可以被
 * 公开分享，只允许展示聚合数字。给这些结构加字段前先想清楚这一点。
 */

export interface Campaign {
  id: string
  name: string
  accountIds: string[]
  accountLabels: Record<string, string>
  accountProfiles: Record<string, AccountProfile>
  totalTarget: number
  accessPasswordEnabled: boolean
  /** 分享网页是否允许打开粉丝详情与进粉趋势。 */
  allowFanData: boolean
  accountTargets: Record<string, number>
  accountTargetsManual: boolean
  resetTime: string
  startAt: number
  endAt?: number
  dedupLibraryIds: string[]
  dedupBeforeAt?: number
  dedupAccountIds: string[]
  /** 只统计这些投放来源码；空 = 全部来源 */
  sourceCodes: string[]
  /** 公开看板是否允许中国大陆 / 香港 IP（默认都不允许） */
  allowCnIp: boolean
  allowHkIp: boolean
  tzOffsetMinutes: number
  createdBy?: string
  createdAt: number
  updatedAt: number
}

export interface AccountProfile {
  channel: string
  handle?: string
  avatarMediaId?: string
  status?: 'online' | 'offline' | 'error' | 'removed'
}

export interface CampaignInput {
  name: string
  accountIds: string[]
  accountLabels?: Record<string, string>
  accountProfiles?: Record<string, AccountProfile>
  totalTarget?: number
  accessPasswordEnabled?: boolean
  accessPassword?: string
  allowFanData?: boolean
  accountTargets?: Record<string, number>
  accountTargetsManual?: boolean
  resetTime?: string
  startAt: number
  endAt?: number
  dedupLibraryIds?: string[]
  dedupBeforeAt?: number
  dedupAccountIds?: string[]
  sourceCodes?: string[]
  allowCnIp?: boolean
  allowHkIp?: boolean
  tzOffsetMinutes?: number
}

export interface CampaignLink {
  token: string
  campaignId: string
  label?: string
  /** 空 = 永不过期 */
  expiresAt?: number
  revoked: boolean
  createdAt: number
  /** 派生：未撤销且未过期 */
  active: boolean
}

export interface LinkOptions {
  label?: string
  expiresAt?: number
}

export interface Bucket {
  /** 窗口内账号申请次数（每个客户-账号组合各计一次） */
  total: number
  duplicate: number
  fresh: number
}

export interface CampaignStats {
  total: number
  duplicate: number
  fresh: number
  effective: number
  duplicateBy: { library: number; timeRange: number }
  byAccount: Array<{
    accountId: string
    channel: string
    label?: string
    handle?: string
    avatarMediaId?: string
    avatarUrl?: string
    status?: 'online' | 'offline' | 'error' | 'removed'
    dayTotal?: number
    dayFresh?: number
    dayDuplicate?: number
  } & Bucket>
  today?: Bucket
  removed?: Bucket & { accounts: number; dayTotal: number; dayFresh: number; dayDuplicate: number }
  byDay: Array<{ date: string } & Bucket>
  /** 按投放来源拆分；code 是广告 id 或追踪码，未归因的 code 为空 */
  bySource: Array<{ code: string; via?: 'ad' | 'code' } & Bucket>
  response: { replied: number; replyRate: number; medianFirstReplySec: number | null }
  computedAt: number
}

export interface CampaignStatsResult {
  campaign: Campaign
  stats: CampaignStats
}

export interface FanLibrary {
  id: string
  name: string
  channel: string
  /** export=从系统历史导出，import=外部名单导入 */
  source: string
  entryCount: number
  createdAt: number
}

/** 导入结果：除了成功条数，还要把问题行回报给用户 */
export interface ImportResult {
  library?: FanLibrary
  added: number
  parsed: {
    contactIds: string[]
    errors: string[]
    totalLines: number
    duplicates: number
  }
}

/** 支持建重粉库的平台（Bot 渠道没有稳定的自然人标识，不参与判重） */
export const LIBRARY_CHANNELS = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'line', label: 'LINE' },
  { value: 'kakaotalk', label: 'KakaoTalk' },
  { value: 'facebook', label: 'Facebook Messenger' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'x', label: 'X' },
  { value: 'snapchat', label: 'Snapchat' }
] as const
