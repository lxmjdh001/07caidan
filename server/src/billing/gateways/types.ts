import type { Cents } from '../money.ts'

/** 各支付通道共用的下单入参 */
export interface CreatePaymentInput {
  /** 商户订单号 */
  orderId: string
  /** 用户应付金额（美分 USD） */
  payableCents: Cents
  /** 收款币种 */
  currency: string
  /** 收款金额，目标币种最小单位（如分、日元为整元） */
  payableLocal: number
  subject: string
  /** 支付完成后跳回的页面 */
  returnUrl: string
  /** 通道异步回调地址 */
  notifyUrl: string
  clientIp?: string
}

export interface CreatePaymentResult {
  /** 跳转支付的地址（网页支付） */
  payUrl?: string
  /** 需要用户扫码或转账的内容（USDT 收款地址、二维码内容） */
  payload?: Record<string, string>
}

/**
 * 回调校验结果。
 *
 * 注意 amountLocal 是**目标币种最小单位**，用于和订单金额比对 ——
 * 只验签不验金额，攻击者拿一笔 0.01 的真实回调就能把大额订单标记成已支付。
 */
export interface VerifyResult {
  ok: boolean
  /** 商户订单号 */
  orderId?: string
  /** 通道流水号 */
  tradeNo?: string
  /** 通道回报的实付金额（目标币种最小单位） */
  amountLocal?: number
  /** 通道认为的支付状态 */
  paid?: boolean
  reason?: string
}

/** 通道回调的原始输入：查询参数 / 表单字段 / 原始 body */
export interface CallbackInput {
  params: Record<string, string>
  rawBody?: string
  headers?: Record<string, string>
}

/**
 * 支付通道。
 *
 * 有意做成纯逻辑接口（不含网络调用）：签名与校验是资损高发区，
 * 必须能脱离网络单测。真正发 HTTP 的部分由调用方注入。
 */
export interface PaymentGateway {
  readonly type: string
  createPayment(input: CreatePaymentInput, config: Record<string, string>): CreatePaymentResult
  verifyCallback(input: CallbackInput, config: Record<string, string>): VerifyResult
  /** 回调后要回给通道的响应体（易支付要求返回 "success"） */
  callbackAck(): string
}
