import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { queryUzfPayments, signUzfQuery } from '../src/billing/gateways/uzf-query.ts'

describe('UZF 查询签名', () => {
  test('与 Python query_api.py 的排序和 HMAC 规则一致', () => {
    assert.equal(
      signUzfQuery({ currency: 'USDT', amount: '10.05' }, '1700000000', 'test-secret'),
      'b05ba3a369aed97a781ed7b484497c21b633c617145165d6efb8c4e85b007356'
    )
  })
})

describe('UZF 流水筛选', () => {
  test('使用 /api/query 并只保留订单创建后的精确金额 USDT 流水', async () => {
    const createdAt = 1_700_000_000_000
    let requested = ''
    const result = await queryUzfPayments({
      baseUrl: 'http://uzf.test:6000',
      secret: 'test-secret',
      amountMinor: 1005,
      notBeforeMs: createdAt,
      now: createdAt + 10_000,
      fetchFn: async (input) => {
        requested = String(input)
        return new Response(JSON.stringify({
          success: true,
          data: {
            transfers: [
              { bill_id: 'new', amount: 10.05, currency: 'USDT', bill_timestamp: createdAt + 1000 },
              { bill_id: 'old', amount: 10.05, currency: 'USDT', bill_timestamp: createdAt - 300_000 },
              { bill_id: 'wrong-amount', amount: 10.06, currency: 'USDT', bill_timestamp: createdAt + 2000 },
              { bill_id: 'wrong-currency', amount: 10.05, currency: 'USDC', bill_timestamp: createdAt + 3000 }
            ]
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.ok && result.transfers.map((x) => x.billId), ['new'])
    const url = new URL(requested)
    assert.equal(url.pathname, '/api/query')
    assert.equal(url.searchParams.get('amount'), '10.05')
    assert.equal(url.searchParams.get('currency'), 'USDT')
    assert.ok(url.searchParams.get('signature'))
  })

  test('配置缺失和坏响应不会误判到账', async () => {
    assert.deepEqual(
      await queryUzfPayments({ baseUrl: '', secret: '', amountMinor: 100, notBeforeMs: 0 }),
      { ok: false, reason: 'not_configured' }
    )
    const result = await queryUzfPayments({
      baseUrl: 'http://uzf.test',
      secret: 's',
      amountMinor: 100,
      notBeforeMs: 0,
      fetchFn: async () => new Response('{bad', { status: 200 })
    })
    assert.deepEqual(result, { ok: false, reason: 'bad_response' })
  })
})
