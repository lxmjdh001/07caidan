import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import { PaypalGateway, paypalAmountToMinor } from '../src/billing/gateways/paypal.ts'
import { UsdtGateway, amountOffset, uniqueAmount } from '../src/billing/gateways/usdt.ts'
import {
  YipayGateway,
  buildSignString,
  minorToYuan,
  signYipay,
  verifyYipaySign,
  yuanToMinor
} from '../src/billing/gateways/yipay.ts'

const KEY = 'test_merchant_key'

describe('易支付签名', () => {
  test('待签名串按参数名升序、不做 URL 编码', () => {
    const s = buildSignString({ pid: '1001', money: '10.00', name: 'a b' })
    assert.equal(s, 'money=10.00&name=a b&pid=1001')
  })

  test('剔除 sign / sign_type / 空值', () => {
    const s = buildSignString({
      pid: '1001',
      sign: 'xxx',
      sign_type: 'MD5',
      empty: '',
      money: '1.00'
    })
    assert.equal(s, 'money=1.00&pid=1001')
  })

  test('签名 = md5(待签名串 + 密钥)，小写', () => {
    const params = { pid: '1001', money: '10.00' }
    const expected = createHash('md5').update('money=10.00&pid=1001' + KEY).digest('hex')
    assert.equal(signYipay(params, KEY), expected)
    assert.equal(signYipay(params, KEY), signYipay(params, KEY).toLowerCase())
  })

  test('参数顺序不影响签名', () => {
    const a = signYipay({ pid: '1', money: '2', name: 'x' }, KEY)
    const b = signYipay({ name: 'x', money: '2', pid: '1' }, KEY)
    assert.equal(a, b)
  })

  test('改任一参数或密钥，签名都会变', () => {
    const base = signYipay({ pid: '1', money: '10.00' }, KEY)
    assert.notEqual(base, signYipay({ pid: '1', money: '10.01' }, KEY))
    assert.notEqual(base, signYipay({ pid: '2', money: '10.00' }, KEY))
    assert.notEqual(base, signYipay({ pid: '1', money: '10.00' }, 'other_key'))
  })

  test('验签：正确通过、篡改拒绝、缺签名拒绝', () => {
    const params: Record<string, string> = { pid: '1001', money: '10.00', out_trade_no: 'o1' }
    params.sign = signYipay(params, KEY)
    assert.equal(verifyYipaySign(params, KEY), true)

    assert.equal(verifyYipaySign({ ...params, money: '99.00' }, KEY), false)
    assert.equal(verifyYipaySign({ ...params, sign: undefined as unknown as string }, KEY), false)
    assert.equal(verifyYipaySign(params, 'wrong_key'), false)
  })

  test('大写签名也认（部分实现回大写）', () => {
    const params: Record<string, string> = { pid: '1', money: '1.00' }
    params.sign = signYipay(params, KEY).toUpperCase()
    assert.equal(verifyYipaySign(params, KEY), true)
  })
})

describe('易支付金额换算', () => {
  test('元 → 分', () => {
    assert.equal(yuanToMinor('10.00'), 1000)
    assert.equal(yuanToMinor('10'), 1000)
    assert.equal(yuanToMinor('10.5'), 1050)
    assert.equal(yuanToMinor('0.01'), 1)
  })
  test('非法金额返回 undefined 而不是 NaN', () => {
    for (const bad of ['', 'abc', '-1', '1.234']) assert.equal(yuanToMinor(bad), undefined, bad)
  })
  test('分 → 元始终两位小数', () => {
    assert.equal(minorToYuan(1000), '10.00')
    assert.equal(minorToYuan(5), '0.05')
  })
})

describe('易支付回调', () => {
  const gw = new YipayGateway()
  const config = { pid: '1001', key: KEY, endpoint: 'https://pay.example.com' }

  function callback(over: Record<string, string> = {}) {
    const p: Record<string, string> = {
      pid: '1001',
      out_trade_no: 'order-1',
      trade_no: 'T123',
      money: '10.00',
      trade_status: 'TRADE_SUCCESS',
      ...over
    }
    p.sign = signYipay(p, KEY)
    return { params: p }
  }

  test('合法回调解析出订单号、流水号与金额', () => {
    const r = gw.verifyCallback(callback(), config)
    assert.equal(r.ok, true)
    assert.equal(r.orderId, 'order-1')
    assert.equal(r.tradeNo, 'T123')
    assert.equal(r.amountLocal, 1000)
    assert.equal(r.paid, true)
  })

  test('签名错误直接拒绝', () => {
    const bad = callback()
    bad.params.money = '9999.00'
    assert.deepEqual(gw.verifyCallback(bad, config), { ok: false, reason: 'bad_sign' })
  })

  test('别家商户的回调进不来', () => {
    const other = { ...config, pid: '2002' }
    const r = gw.verifyCallback(callback(), other)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'pid_mismatch')
  })

  test('非成功状态不算已支付', () => {
    const r = gw.verifyCallback(callback({ trade_status: 'WAIT_BUYER_PAY' }), config)
    assert.equal(r.ok, true)
    assert.equal(r.paid, false)
  })

  test('建单链接带签名与金额', () => {
    const r = gw.createPayment(
      {
        orderId: 'o1',
        payableCents: 1000,
        currency: 'CNY',
        payableLocal: 7200,
        subject: '充值',
        returnUrl: 'https://a/return',
        notifyUrl: 'https://a/notify'
      },
      config
    )
    assert.ok(r.payUrl?.includes('out_trade_no=o1'))
    assert.ok(r.payUrl?.includes('money=72.00'))
    assert.ok(r.payUrl?.includes('sign='))
  })

  test('回调应答是 success', () => {
    assert.equal(gw.callbackAck(), 'success')
  })
})

describe('PayPal', () => {
  const gw = new PaypalGateway()
  const body = JSON.stringify({
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      id: 'CAP-1',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '10.00' },
      custom_id: 'order-9'
    }
  })

  test('未经验签的回调一律拒绝 —— 否则任何人都能伪造入账', () => {
    const r = gw.verifyCallback({ params: {}, rawBody: body }, {})
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'signature_not_verified')
  })

  test('已验签的完成事件解析正确', () => {
    const r = gw.verifyCallback(
      { params: {}, rawBody: body, headers: { 'x-verified': 'true' } },
      {}
    )
    assert.equal(r.ok, true)
    assert.equal(r.orderId, 'order-9')
    assert.equal(r.tradeNo, 'CAP-1')
    assert.equal(r.amountLocal, 1000)
    assert.equal(r.paid, true)
  })

  test('未完成状态不算已支付', () => {
    const pending = JSON.stringify({
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'X', status: 'PENDING', custom_id: 'o1' }
    })
    const r = gw.verifyCallback(
      { params: {}, rawBody: pending, headers: { 'x-verified': 'true' } },
      {}
    )
    assert.equal(r.paid, false)
  })

  test('坏 JSON 不抛异常', () => {
    const r = gw.verifyCallback(
      { params: {}, rawBody: '{oops', headers: { 'x-verified': 'true' } },
      {}
    )
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'bad_json')
  })

  test('金额字符串换算', () => {
    assert.equal(paypalAmountToMinor('10.00'), 1000)
    assert.equal(paypalAmountToMinor('0.99'), 99)
    assert.equal(paypalAmountToMinor('abc'), undefined)
  })
})

describe('USDT', () => {
  const gw = new UsdtGateway()
  const config = { address: 'TXxxx', callbackSecret: 's3cret', minConfirmations: '2' }

  test('金额偏移稳定且落在 1..99', () => {
    for (const id of ['a', 'order-1', 'zzzz', '123456']) {
      const off = amountOffset(id)
      assert.ok(off >= 1 && off <= 99, id)
      assert.equal(off, amountOffset(id), '同一订单必须得到同样的偏移')
    }
  })

  test('不同订单尽量得到不同金额（避免撞单）', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `order-${i}`)
    const amounts = new Set(ids.map((id) => uniqueAmount(1000, id)))
    assert.ok(amounts.size > 30, `唯一金额过少：${amounts.size}`)
  })

  test('建单返回收款地址与精确金额', () => {
    const r = gw.createPayment(
      {
        orderId: 'o1',
        payableCents: 1000,
        currency: 'USDT',
        payableLocal: 1000,
        subject: '充值',
        returnUrl: '',
        notifyUrl: ''
      },
      config
    )
    assert.equal(r.payload?.address, 'TXxxx')
    assert.equal(r.payload?.network, 'TRC20')
    assert.equal(Number(r.payload?.amountMinor), 1000 + amountOffset('o1'))
  })

  test('密钥不对的回调拒绝', () => {
    const r = gw.verifyCallback({ params: { secret: 'wrong', order_id: 'o1' } }, config)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'bad_secret')
  })

  test('确认数不足时不算已支付 —— 链重组会让转账消失', () => {
    const r = gw.verifyCallback(
      { params: { secret: 's3cret', order_id: 'o1', amount_minor: '1050', confirmations: '1' } },
      config
    )
    assert.equal(r.ok, true)
    assert.equal(r.paid, false)
  })

  test('确认数足够则算已支付', () => {
    const r = gw.verifyCallback(
      { params: { secret: 's3cret', order_id: 'o1', amount_minor: '1050', confirmations: '3' } },
      config
    )
    assert.equal(r.paid, true)
    assert.equal(r.amountLocal, 1050)
  })
})
