import { createHmac } from 'node:crypto'

export interface UzfTransfer {
  billId: string
  amountMinor: number
  currency: string
  billTimestamp: number
}

export type UzfQueryResult =
  | { ok: true; transfers: UzfTransfer[] }
  | { ok: false; reason: 'not_configured' | 'bad_url' | 'timeout' | 'network' | 'bad_response' }

interface QueryInput {
  baseUrl: string
  secret: string
  amountMinor: number
  currency?: string
  /** 早于订单创建时间的同金额流水不能用于本订单。 */
  notBeforeMs: number
  now?: number
  timeoutMs?: number
  fetchFn?: typeof fetch
}

/** 与 uzf/query_api.py 完全一致的 HMAC-SHA256 签名。 */
export function signUzfQuery(
  params: Record<string, string>,
  timestamp: string,
  secret: string
): string {
  const paramString = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const source = `${paramString}&timestamp=${timestamp}&secret=${secret}`
  return createHmac('sha256', secret).update(source).digest('hex')
}

/**
 * 查询 UZF 的完整匹配列表，而不是 /api/check 的第一条。
 * 同金额在两小时窗口内可能重复，拿到全部流水后才能按订单时间和流水号安全筛选。
 */
export async function queryUzfPayments(input: QueryInput): Promise<UzfQueryResult> {
  const baseUrl = input.baseUrl.trim()
  const secret = input.secret.trim()
  if (!baseUrl || !secret) return { ok: false, reason: 'not_configured' }

  let url: URL
  try {
    const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      return { ok: false, reason: 'bad_url' }
    }
    url = new URL('api/query', base)
  } catch {
    return { ok: false, reason: 'bad_url' }
  }

  const currency = (input.currency || 'USDT').toUpperCase()
  const amount = formatMinor(input.amountMinor)
  const timestamp = String(Math.floor((input.now ?? Date.now()) / 1000))
  const params = { amount, currency }
  url.searchParams.set('amount', amount)
  url.searchParams.set('currency', currency)
  url.searchParams.set('timestamp', timestamp)
  url.searchParams.set('signature', signUzfQuery(params, timestamp, secret))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 5000)
  timer.unref?.()
  try {
    const response = await (input.fetchFn ?? fetch)(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    })
    if (!response.ok) return { ok: false, reason: 'bad_response' }
    let body: { success?: unknown; data?: { transfers?: unknown } }
    try {
      body = (await response.json()) as typeof body
    } catch {
      return { ok: false, reason: 'bad_response' }
    }
    if (body.success !== true || !Array.isArray(body.data?.transfers)) {
      return { ok: false, reason: 'bad_response' }
    }

    // 容许两分钟服务器时钟误差；不能认领订单创建前的旧流水。
    const earliest = input.notBeforeMs - 2 * 60_000
    const transfers: UzfTransfer[] = []
    for (const raw of body.data.transfers as Array<Record<string, unknown>>) {
      const amountMinor = Math.round(Number(raw.amount) * 100)
      const rawTimestamp = Number(raw.bill_timestamp)
      const billTimestamp = rawTimestamp < 10_000_000_000 ? rawTimestamp * 1000 : rawTimestamp
      const billId = String(raw.bill_id ?? '').trim()
      const rowCurrency = String(raw.currency ?? '').toUpperCase()
      if (
        !billId ||
        !Number.isFinite(amountMinor) ||
        amountMinor !== Math.round(input.amountMinor) ||
        rowCurrency !== currency ||
        !Number.isFinite(billTimestamp) ||
        billTimestamp < earliest
      ) {
        continue
      }
      transfers.push({ billId, amountMinor, currency: rowCurrency, billTimestamp })
    }
    transfers.sort((a, b) => b.billTimestamp - a.billTimestamp)
    return { ok: true, transfers }
  } catch (error) {
    return {
      ok: false,
      reason:
        controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
          ? 'timeout'
          : 'network'
    }
  } finally {
    clearTimeout(timer)
  }
}

function formatMinor(value: number): string {
  const minor = Math.max(0, Math.round(value))
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`
}
