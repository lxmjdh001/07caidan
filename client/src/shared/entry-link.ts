/**
 * 带追踪码的入口链接生成。
 *
 * 放在 shared 而不是 main：这是纯字符串拼接，渲染进程要实时预览，
 * 走一趟 IPC 只会让输入框卡顿。解析侧在 main/core/lead-source.ts。
 *
 * 三个平台都只有「预填文案」这一个可用参数位，所以追踪码只能写进
 * 客户要发的第一句话里（WhatsApp 点广告进来的另有平台级归因，见 lead-source.ts）。
 */

export type EntryChannel = 'whatsapp' | 'telegram' | 'line'

export const DEFAULT_GREETING = '你好，我想了解一下'

/** 追踪码允许的字符：字母数字下划线连字符，1-32 位 */
export function isValidCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(code.trim())
}

/** 生成带追踪码的 WhatsApp 入口链接 */
export function waLink(phone: string, code: string, greeting = DEFAULT_GREETING): string {
  const digits = phone.replace(/\D/g, '')
  return `https://wa.me/${digits}?text=${encodeURIComponent(`${greeting} [ref:${code}]`)}`
}

/** 生成带追踪码的 Telegram 入口链接（普通账号用 ?text=，Bot 才有 ?start=） */
export function tgLink(username: string, code: string, greeting = DEFAULT_GREETING): string {
  const name = username.replace(/^@/, '')
  return `https://t.me/${name}?text=${encodeURIComponent(`${greeting} [ref:${code}]`)}`
}

/** 生成带追踪码的 LINE 入口链接（官方账号预填消息） */
export function lineLink(lineId: string, code: string, greeting = DEFAULT_GREETING): string {
  const id = lineId.startsWith('@') ? lineId : `@${lineId}`
  return `https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(`${greeting} [ref:${code}]`)}`
}

/** 按平台分发 */
export function entryLink(
  channel: EntryChannel,
  handle: string,
  code: string,
  greeting = DEFAULT_GREETING
): string {
  if (channel === 'whatsapp') return waLink(handle, code, greeting)
  if (channel === 'telegram') return tgLink(handle, code, greeting)
  return lineLink(handle, code, greeting)
}
