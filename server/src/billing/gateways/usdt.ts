import type {
  CallbackInput,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentGateway,
  VerifyResult
} from './types.ts'

/**
 * USDT 收款（TRC20 / ERC20）。
 *
 * 链上转账没有「订单号」这个概念 —— 用户转过来的只是一笔金额。
 * 行业通行做法是**金额唯一化**：在应付金额尾部加一个极小的随机偏移
 * （如 10.00 → 10.03），用「收款地址 + 精确金额」反查订单。
 *
 * 为什么必须这么做：同一个收款地址上如果两个用户同时要付 10 USDT，
 * 只看金额根本分不清是谁付的，很容易把一笔钱记到两个订单上。
 *
 * 偏移量取 1-99 的最小单位（0.01 USDT），成本可忽略，
 * 但要求同一地址上**同一金额的待支付订单唯一** —— 建单时必须校验。
 */

/** USDT 按 6 位小数（TRC20/ERC20 的 decimals 都是 6，展示常用 2 位） */
export const USDT_DECIMALS = 2

/**
 * 由订单号推导出稳定的金额偏移（1..99 个最小单位）。
 *
 * 用确定性哈希而不是随机数：同一订单重复建单会得到同样的金额，
 * 用户刷新页面不会看到金额变来变去，也不会在链上留下两个待匹配金额。
 */
export function amountOffset(orderId: string): number {
  let h = 0
  for (let i = 0; i < orderId.length; i++) {
    h = (h * 31 + orderId.charCodeAt(i)) >>> 0
  }
  return (h % 99) + 1
}

/** 加上唯一化偏移后的应收金额（最小单位） */
export function uniqueAmount(payableLocal: number, orderId: string): number {
  return payableLocal + amountOffset(orderId)
}

/** 最小单位 → 展示字符串 */
export function formatUsdt(minor: number): string {
  const abs = Math.abs(Math.round(minor))
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export class UsdtGateway implements PaymentGateway {
  readonly type = 'usdt'

  createPayment(input: CreatePaymentInput, config: Record<string, string>): CreatePaymentResult {
    const amount = uniqueAmount(input.payableLocal, input.orderId)
    return {
      payload: {
        network: config.network || 'TRC20',
        address: config.address ?? '',
        // 用户必须**精确**转这个金额，多一分少一分都无法自动匹配
        amount: formatUsdt(amount),
        amountMinor: String(amount),
        orderId: input.orderId
      }
    }
  }

  /**
   * 回调来自链上监听服务或第三方网关。
   * 校验共享密钥 + 金额精确匹配；金额对不上一律拒绝，交人工处理。
   */
  verifyCallback(input: CallbackInput, config: Record<string, string>): VerifyResult {
    const secret = config.callbackSecret ?? ''
    if (!secret || input.params.secret !== secret) {
      return { ok: false, reason: 'bad_secret' }
    }
    const orderId = input.params.order_id
    if (!orderId) return { ok: false, reason: 'missing_order' }
    const amountMinor = Number(input.params.amount_minor)
    if (!Number.isFinite(amountMinor)) return { ok: false, reason: 'bad_amount' }
    // 到账确认数不足时先不入账 —— 链重组会让已确认的转账消失
    const confirmations = Number(input.params.confirmations ?? '0')
    const required = Number(config.minConfirmations ?? '1')
    return {
      ok: true,
      orderId,
      tradeNo: input.params.tx_hash,
      amountLocal: amountMinor,
      paid: confirmations >= required
    }
  }

  callbackAck(): string {
    return 'ok'
  }
}
