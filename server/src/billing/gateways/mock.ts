import type {
  CallbackInput,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentGateway,
  VerifyResult
} from './types.ts'

/**
 * 测试/开发用假通道。
 *
 * 不发任何网络请求：建单返回一个「假支付页」的载荷，
 * 回调用共享密钥验证。开发期可以用 curl 手动打回调模拟支付成功，
 * 测试里则直接构造回调请求 —— 这正是「简单模拟、不真调支付」的入口。
 */
export class MockGateway implements PaymentGateway {
  readonly type = 'mock'

  createPayment(input: CreatePaymentInput, _config: Record<string, string>): CreatePaymentResult {
    return {
      payload: {
        orderId: input.orderId,
        amountLocal: String(input.payableLocal),
        currency: input.currency,
        hint: '开发通道：向回调地址 POST {order_id, amount_minor, status:"paid", secret} 即可模拟支付成功'
      }
    }
  }

  verifyCallback(input: CallbackInput, config: Record<string, string>): VerifyResult {
    const secret = config.callbackSecret ?? ''
    if (!secret || input.params.secret !== secret) return { ok: false, reason: 'bad_secret' }
    const orderId = input.params.order_id
    if (!orderId) return { ok: false, reason: 'missing_order' }
    const amountLocal = input.params.amount_minor ? Number(input.params.amount_minor) : undefined
    return {
      ok: true,
      orderId,
      tradeNo: input.params.trade_no || `mock-${orderId}`,
      amountLocal: Number.isFinite(amountLocal) ? amountLocal : undefined,
      paid: input.params.status === 'paid'
    }
  }

  callbackAck(): string {
    return 'ok'
  }
}
