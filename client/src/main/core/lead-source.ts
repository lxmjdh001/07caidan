/**
 * 客户来源识别（投放归因）。
 *
 * 老板在不同广告/落地页上挂不同的入口链接，需要知道进线的客户是从哪个广告来的。
 * 三个平台能拿到的信息完全不同：
 *
 * - WhatsApp：两条路
 *   ① 点击广告进来（Click-to-WhatsApp）→ 首条消息的 contextInfo.externalAdReply
 *      自带 ctwaClid / sourceId / sourceUrl，无需在链接里做手脚，最准。
 *   ② 普通 wa.me 链接 → 只能靠 `?text=` 预填文案，把追踪码写进客户发的第一句话。
 * - Telegram 普通账号：没有 bot 的 `?start=` 深链，只有 `t.me/user?text=` 预填，
 *   所以只能走追踪码方案。
 * - LINE：`line.me/R/oaMessage/@id/?文案` 预填，同样只能走追踪码。
 *
 * 因此追踪码解析是三平台共用的兜底方案，CTWA 是 WhatsApp 独有的加强项。
 */

export interface LeadSource {
  /** 归一化后的来源标识，用于统计分组 */
  code: string
  /** 来源识别方式 */
  via: 'ad' | 'code'
  /** 广告平台给的点击 id（仅 CTWA 有），便于回传转化 */
  clickId?: string
  /** 广告落地页 / 素材 id（仅 CTWA 有） */
  sourceUrl?: string
  /** 展示用标题（仅 CTWA 有） */
  title?: string
}

/**
 * 从首条消息文本里解析追踪码。
 *
 * 约定格式：文案里出现 `[ref:XXXX]` 或 `#ref-XXXX`（大小写不敏感）。
 * 选方括号是因为它在各语言里都不常见，且 wa.me / t.me / line 预填链接
 * URL 编码后仍然稳定；同时避免用纯数字，防止和客户随手打的内容撞车。
 */
export function parseTrackingCode(text: string | undefined): string | undefined {
  if (!text) return undefined
  const bracket = /\[ref:\s*([A-Za-z0-9_-]{1,32})\s*\]/i.exec(text)
  if (bracket?.[1]) return normalizeCode(bracket[1])
  const hash = /#ref-([A-Za-z0-9_-]{1,32})\b/i.exec(text)
  if (hash?.[1]) return normalizeCode(hash[1])
  return undefined
}

function normalizeCode(raw: string): string {
  return raw.trim().toLowerCase()
}

/** Baileys contextInfo.externalAdReply 的相关字段（只取归因需要的） */
export interface AdReplyInfo {
  ctwaClid?: string | null
  sourceId?: string | null
  sourceUrl?: string | null
  sourceType?: string | null
  title?: string | null
  ref?: string | null
}

/**
 * 从 Click-to-WhatsApp 的广告上下文提取来源。
 * sourceId 是广告/贴文 id，最适合做分组；没有就退到 ctwaClid。
 */
export function fromAdReply(ad: AdReplyInfo | undefined | null): LeadSource | undefined {
  if (!ad) return undefined
  const code = ad.sourceId || ad.ref || ad.ctwaClid
  if (!code) return undefined
  return {
    code: normalizeCode(code),
    via: 'ad',
    clickId: ad.ctwaClid ?? undefined,
    sourceUrl: ad.sourceUrl ?? undefined,
    title: ad.title ?? undefined
  }
}

/**
 * 综合判定一条入站消息的来源。
 * 广告上下文优先 —— 它由平台提供，比客户可能改掉的预填文案可靠。
 */
export function detectLeadSource(
  text: string | undefined,
  ad?: AdReplyInfo | null
): LeadSource | undefined {
  const byAd = fromAdReply(ad)
  if (byAd) return byAd
  const code = parseTrackingCode(text)
  return code ? { code, via: 'code' } : undefined
}

/** 生成带追踪码的 WhatsApp 入口链接 */
export function waLink(phone: string, code: string, greeting = '你好，我想了解一下'): string {
  const digits = phone.replace(/\D/g, '')
  return `https://wa.me/${digits}?text=${encodeURIComponent(`${greeting} [ref:${code}]`)}`
}

/** 生成带追踪码的 Telegram 入口链接（普通账号用 ?text=，Bot 才有 ?start=） */
export function tgLink(username: string, code: string, greeting = '你好，我想了解一下'): string {
  const name = username.replace(/^@/, '')
  return `https://t.me/${name}?text=${encodeURIComponent(`${greeting} [ref:${code}]`)}`
}

/** 生成带追踪码的 LINE 入口链接（官方账号预填消息） */
export function lineLink(lineId: string, code: string, greeting = '你好，我想了解一下'): string {
  const id = lineId.startsWith('@') ? lineId : `@${lineId}`
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(`${greeting} [ref:${code}]`)}`
}
