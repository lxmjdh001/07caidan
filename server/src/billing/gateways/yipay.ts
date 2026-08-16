import { createHash, timingSafeEqual } from 'node:crypto'
import type {
  CallbackInput,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentGateway,
  VerifyResult
} from './types.ts'

/**
 * 易支付（彩虹易支付及其兼容实现）。
 *
 * 签名规则（各家实现基本一致）：
 * 1. 取所有参数，**剔除 sign、sign_type 以及值为空的字段**
 * 2. 按参数名 ASCII 升序排序
 * 3. 拼成 a=1&b=2 的形式（**不做 URL 编码**，这点和微信/支付宝不同，很容易踩坑）
 * 4. 末尾直接追加商户密钥（注意：是直接拼接，中间没有 &key=）
 * 5. 取 MD5 小写
 *
 * MD5 在这里是通道方定的，我们没得选；但比对时仍用时间安全比较，
 * 避免通过响应时间侧信道试探签名。
 */

/** 参与签名的参数：剔除 sign / sign_type / 空值 */
export function signableParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) {
    if (k === 'sign' || k === 'sign_type') continue
    if (v === undefined || v === null || v === '') continue
    out[k] = String(v)
  }
  return out
}

/** 按规则拼出待签名字符串 */
export function buildSignString(params: Record<string, string>): string {
  const usable = signableParams(params)
  return Object.keys(usable)
    .sort()
    .map((k) => `${k}=${usable[k]}`)
    .join('&')
}

export function signYipay(params: Record<string, string>, key: string): string {
  return createHash('md5')
    .update(buildSignString(params) + key, 'utf8')
    .digest('hex')
}

/** 时间安全的字符串比较；长度不同直接判否（长度本身不是秘密） */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

export function verifyYipaySign(params: Record<string, string>, key: string): boolean {
  const given = params.sign
  if (!given) return false
  return safeEqual(given.toLowerCase(), signYipay(params, key))
}

/** 金额字符串（元） → 最小单位整数（分）。易支付回调的 money 是 "12.34" 这种 */
export function yuanToMinor(money: string | undefined): number | undefined {
  if (!money) return undefined
  const cleaned = money.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined
  const [i, d = ''] = cleaned.split('.')
  return Number(i) * 100 + Number(d.padEnd(2, '0'))
}

/** 最小单位整数 → 元字符串，两位小数 */
export function minorToYuan(minor: number): string {
  const abs = Math.abs(Math.round(minor))
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export class YipayGateway implements PaymentGateway {
  readonly type = 'yipay'

  createPayment(input: CreatePaymentInput, config: Record<string, string>): CreatePaymentResult {
    const endpoint = (config.endpoint ?? '').replace(/\/$/, '')
    const params: Record<string, string> = {
      pid: config.pid ?? '',
      type: config.payType || 'alipay',
      out_trade_no: input.orderId,
      notify_url: input.notifyUrl,
      return_url: input.returnUrl,
      name: input.subject,
      money: minorToYuan(input.payableLocal),
      sitename: config.siteName || ''
    }
    const sign = signYipay(params, config.key ?? '')
    const query = new URLSearchParams({ ...signableParams(params), sign, sign_type: 'MD5' })
    return { payUrl: `${endpoint}/submit.php?${query.toString()}` }
  }

  verifyCallback(input: CallbackInput, config: Record<string, string>): VerifyResult {
    const p = input.params
    if (!verifyYipaySign(p, config.key ?? '')) return { ok: false, reason: 'bad_sign' }
    // pid 必须对得上，否则别人家的商户回调也能进来
    if (config.pid && p.pid && p.pid !== config.pid) return { ok: false, reason: 'pid_mismatch' }
    if (!p.out_trade_no) return { ok: false, reason: 'missing_order' }
    return {
      ok: true,
      orderId: p.out_trade_no,
      tradeNo: p.trade_no,
      amountLocal: yuanToMinor(p.money),
      paid: p.trade_status === 'TRADE_SUCCESS'
    }
  }

  callbackAck(): string {
    return 'success'
  }
}
