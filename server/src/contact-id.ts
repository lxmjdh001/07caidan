/**
 * 客户标识归一化 —— 导入重粉库时，老板手上的名单形态五花八门
 * （带不带国家码、有没有加号、Excel 里粘出来带空格括号），
 * 必须归一到和客户端 resolveContactId 完全一致的格式，否则判重永远不命中。
 *
 * 各平台格式（与 client 侧一一对应）：
 *   whatsapp → wa:+8613800138000     手机号，全网唯一
 *   telegram → tg:123456789          全局用户 id
 *   line     → line:<provider>:U...  userId 只在 Provider 内稳定，必须带作用域
 *   kakaotalk→ kakao:123456789       Kakao 全局数字用户 id
 *   facebook → facebook:<page>:<psid> PSID 只在该主页下稳定
 *   instagram→ instagram:<ig>:<igsid> IGSID 按业务账号作用域隔离
 *   tiktok   → tiktok:<business>:<user> TikTok 用户标识按已授权企业号作用域保存
 *   x        → x:<user> X 用户数字 ID 全局稳定
 *   snapchat → snapchat:<brand>:<creator> Public Profile 会话按品牌作用域保存
 */

export type LibraryChannel = 'whatsapp' | 'telegram' | 'line' | 'kakaotalk' | 'facebook' | 'instagram' | 'tiktok' | 'x' | 'snapchat'

export const LIBRARY_CHANNELS: LibraryChannel[] = [
  'whatsapp', 'telegram', 'line', 'kakaotalk', 'facebook', 'instagram', 'tiktok', 'x', 'snapchat'
]

export function isLibraryChannel(v: string): v is LibraryChannel {
  return (LIBRARY_CHANNELS as string[]).includes(v)
}

export type NormalizeResult =
  | { ok: true; contactId: string }
  | { ok: false; reason: string }

export interface NormalizeOptions {
  /** LINE 必填：该名单属于哪个 Provider */
  lineProvider?: string
}

/** 单条归一化。已经是标准格式的原样通过（支持导出文件再导入）。 */
export function normalizeContactId(
  channel: LibraryChannel,
  raw: string,
  opts: NormalizeOptions = {}
): NormalizeResult {
  const value = raw.trim()
  if (!value) return { ok: false, reason: '空行' }

  switch (channel) {
    case 'whatsapp': {
      if (value.startsWith('wa:+')) {
        return /^wa:\+\d{6,15}$/.test(value)
          ? { ok: true, contactId: value }
          : { ok: false, reason: `手机号位数不合法：${value}` }
      }
      // 去掉空格/横杠/括号，以及某些导出会带的 @s.whatsapp.net 后缀
      const digits = value.replace(/@.*$/, '').replace(/\D/g, '')
      if (digits.length < 6 || digits.length > 15) {
        return { ok: false, reason: `不是有效手机号：${value}` }
      }
      // 没有国家码无法唯一定位，这里不猜，直接让用户补
      if (value.trim().startsWith('0')) {
        return { ok: false, reason: `缺少国家码（0 开头的本地号）：${value}` }
      }
      return { ok: true, contactId: `wa:+${digits}` }
    }

    case 'telegram': {
      if (value.startsWith('tg:')) {
        return /^tg:\d+$/.test(value)
          ? { ok: true, contactId: value }
          : { ok: false, reason: `不是有效的 Telegram 用户 id：${value}` }
      }
      if (value.startsWith('@')) {
        return { ok: false, reason: `用户名无法离线换算成 id，请导出 id：${value}` }
      }
      if (!/^\d+$/.test(value)) return { ok: false, reason: `不是有效的 Telegram 用户 id：${value}` }
      return { ok: true, contactId: `tg:${value}` }
    }

    case 'line': {
      if (value.startsWith('line:')) {
        return /^line:[^:]+:U[0-9a-f]{32}$/i.test(value)
          ? { ok: true, contactId: value }
          : { ok: false, reason: `不是有效的 LINE 标识：${value}` }
      }
      const provider = opts.lineProvider?.trim()
      if (!provider) return { ok: false, reason: 'LINE 名单必须指定 Provider ID' }
      if (!/^U[0-9a-f]{32}$/i.test(value)) {
        return { ok: false, reason: `不是有效的 LINE userId：${value}` }
      }
      return { ok: true, contactId: `line:${provider}:${value}` }
    }

    case 'kakaotalk': {
      const id = value.startsWith('kakao:') ? value.slice('kakao:'.length) : value
      if (!/^\d+$/.test(id)) {
        return { ok: false, reason: `不是有效的 KakaoTalk 用户 id：${value}` }
      }
      return { ok: true, contactId: `kakao:${id}` }
    }

    case 'facebook':
    case 'instagram':
    case 'tiktok': {
      const pattern = new RegExp(`^${channel}:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_.-]{1,128}$`)
      if (!pattern.test(value)) {
        return {
          ok: false,
          reason: `${channel === 'facebook' ? 'Messenger' : channel === 'instagram' ? 'Instagram' : 'TikTok'} 标识必须使用系统导出的完整作用域 ID：${value}`
        }
      }
      return { ok: true, contactId: value }
    }

    case 'x': {
      const id = value.startsWith('x:') ? value.slice(2) : value
      if (!/^\d{1,32}$/.test(id)) {
        return { ok: false, reason: `不是有效的 X 用户数字 ID：${value}` }
      }
      return { ok: true, contactId: `x:${id}` }
    }

    case 'snapchat': {
      if (!/^snapchat:[A-Za-z0-9_-]{8,128}:[A-Za-z0-9_-]{8,128}$/.test(value)) {
        return { ok: false, reason: `Snapchat 标识必须使用系统导出的完整品牌作用域 ID：${value}` }
      }
      return { ok: true, contactId: value }
    }
  }
}

export interface BulkNormalizeResult {
  contactIds: string[]
  /** 归一化失败的行（最多保留前 50 条，避免超大响应） */
  errors: string[]
  /** 输入总行数（去空行后） */
  totalLines: number
  /** 输入内部的重复行数 */
  duplicates: number
}

/** 批量归一化：支持换行/逗号分隔，自动去重并汇报问题行 */
export function normalizeContactList(
  channel: LibraryChannel,
  input: string | string[],
  opts: NormalizeOptions = {}
): BulkNormalizeResult {
  const lines = (Array.isArray(input) ? input : input.split(/[\n,;]+/))
    .map((s) => s.trim())
    .filter(Boolean)

  const seen = new Set<string>()
  const errors: string[] = []
  let duplicates = 0

  for (const line of lines) {
    const r = normalizeContactId(channel, line, opts)
    if (!r.ok) {
      if (errors.length < 50) errors.push(r.reason)
      continue
    }
    if (seen.has(r.contactId)) duplicates++
    else seen.add(r.contactId)
  }

  return { contactIds: [...seen], errors, totalLines: lines.length, duplicates }
}

/** 从标准 contactId 反推所属平台（用于校验库与工单账号是否同平台） */
export function channelOfContactId(contactId: string): LibraryChannel | undefined {
  if (contactId.startsWith('wa:')) return 'whatsapp'
  if (contactId.startsWith('tg:')) return 'telegram'
  if (contactId.startsWith('line:')) return 'line'
  if (contactId.startsWith('kakao:')) return 'kakaotalk'
  if (contactId.startsWith('facebook:')) return 'facebook'
  if (contactId.startsWith('instagram:')) return 'instagram'
  if (contactId.startsWith('tiktok:')) return 'tiktok'
  if (contactId.startsWith('x:')) return 'x'
  if (contactId.startsWith('snapchat:')) return 'snapchat'
  return undefined
}
