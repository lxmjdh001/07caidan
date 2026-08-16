import type {
  CallbackInput,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentGateway,
  VerifyResult
} from './types.ts'

/**
 * PayPal（Orders v2 + Webhook）。
 *
 * 与易支付的关键差异：**PayPal 的 Webhook 签名无法离线验证**，
 * 必须回调 PayPal 的 /v1/notifications/verify-webhook-signature 接口。
 * 因此这里的 verifyCallback 只做「结构与业务字段」校验，
 * 真正的签名验证由 server 侧在收到回调时先行调用 PayPal 完成 ——
 * 把网络调用挡在这个纯函数之外，才能对业务逻辑做无网络单测。
 *
 * 危险的做法是「只解析 body 不验签就入账」：任何人都能伪造一个
 * PAYMENT.CAPTURE.COMPLETED 打过来白嫖。所以下面显式要求调用方
 * 先把验签结果通过 headers['x-verified'] 传进来。
 */

/** PayPal webhook 事件里我们关心的字段 */
export interface PaypalCaptureEvent {
  event_type?: string
  resource?: {
    id?: string
    status?: string
    amount?: { currency_code?: string; value?: string }
    custom_id?: string
    invoice_id?: string
  }
}

/** "12.34" → 1234（PayPal 金额是字符串的元） */
export function paypalAmountToMinor(value: string | undefined, decimals = 2): number | undefined {
  if (!value) return undefined
  const cleaned = value.trim()
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) return undefined
  const [i, d = ''] = cleaned.split('.')
  return Number(i) * 10 ** decimals + Number(d.slice(0, decimals).padEnd(decimals, '0'))
}

/** 已完成收款的事件类型 */
const PAID_EVENTS = new Set(['PAYMENT.CAPTURE.COMPLETED', 'CHECKOUT.ORDER.APPROVED'])

export class PaypalGateway implements PaymentGateway {
  readonly type = 'paypal'

  /**
   * PayPal 建单要走 API，不能纯本地拼 URL。
   * 这里返回创建订单所需的 payload，由调用方发出请求后拿到 approve link。
   */
  createPayment(input: CreatePaymentInput, config: Record<string, string>): CreatePaymentResult {
    return {
      payload: {
        mode: config.mode || 'live',
        intent: 'CAPTURE',
        currency: input.currency,
        // PayPal 用元为单位的字符串
        value: (input.payableLocal / 100).toFixed(2),
        // custom_id 带上商户订单号，回调时据此找回订单
        custom_id: input.orderId,
        return_url: input.returnUrl,
        cancel_url: input.returnUrl,
        description: input.subject
      }
    }
  }

  verifyCallback(input: CallbackInput, _config: Record<string, string>): VerifyResult {
    // 调用方必须先调 PayPal 验签接口，再把结果放进来。没有这个标记一律拒绝。
    if (input.headers?.['x-verified'] !== 'true') {
      return { ok: false, reason: 'signature_not_verified' }
    }
    let event: PaypalCaptureEvent
    try {
      event = JSON.parse(input.rawBody ?? '{}') as PaypalCaptureEvent
    } catch {
      return { ok: false, reason: 'bad_json' }
    }
    const orderId = event.resource?.custom_id || event.resource?.invoice_id
    if (!orderId) return { ok: false, reason: 'missing_order' }
    return {
      ok: true,
      orderId,
      tradeNo: event.resource?.id,
      amountLocal: paypalAmountToMinor(event.resource?.amount?.value),
      paid:
        PAID_EVENTS.has(event.event_type ?? '') &&
        (event.resource?.status ?? '').toUpperCase() === 'COMPLETED'
    }
  }

  callbackAck(): string {
    return 'OK'
  }
}
