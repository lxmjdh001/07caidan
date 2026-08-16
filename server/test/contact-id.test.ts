import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  channelOfContactId,
  normalizeContactId,
  normalizeContactList
} from '../src/contact-id.ts'

const U = 'U' + 'a'.repeat(32)

function ok(r: ReturnType<typeof normalizeContactId>): string {
  assert.equal(r.ok, true, r.ok ? '' : r.reason)
  return (r as { ok: true; contactId: string }).contactId
}

describe('WhatsApp 归一化', () => {
  test('各种脏格式都能还原成同一个标识', () => {
    const expected = 'wa:+8613800138000'
    for (const raw of [
      '+8613800138000',
      '8613800138000',
      '+86 138 0013 8000',
      '+86-138-0013-8000',
      '(86) 13800138000',
      '8613800138000@s.whatsapp.net'
    ]) {
      assert.equal(ok(normalizeContactId('whatsapp', raw)), expected, raw)
    }
  })
  test('已是标准格式的原样通过（导出再导入）', () => {
    assert.equal(ok(normalizeContactId('whatsapp', 'wa:+8613800138000')), 'wa:+8613800138000')
  })
  test('缺国家码的本地号拒绝而不是瞎猜', () => {
    const r = normalizeContactId('whatsapp', '013800138000')
    assert.equal(r.ok, false)
    assert.match((r as { reason: string }).reason, /国家码/)
  })
  test('位数不合法拒绝', () => {
    assert.equal(normalizeContactId('whatsapp', '123').ok, false)
    assert.equal(normalizeContactId('whatsapp', 'wa:+123').ok, false)
  })
})

describe('Telegram 归一化', () => {
  test('纯数字 id', () => {
    assert.equal(ok(normalizeContactId('telegram', '123456789')), 'tg:123456789')
    assert.equal(ok(normalizeContactId('telegram', 'tg:123456789')), 'tg:123456789')
  })
  test('用户名无法离线换算，明确报错', () => {
    const r = normalizeContactId('telegram', '@someone')
    assert.equal(r.ok, false)
    assert.match((r as { reason: string }).reason, /用户名/)
  })
})

describe('LINE 归一化', () => {
  test('必须带 Provider 作用域', () => {
    assert.equal(ok(normalizeContactId('line', U, { lineProvider: 'p1' })), `line:p1:${U}`)
  })
  test('没给 Provider 就拒绝（否则跨 Provider 会误判）', () => {
    const r = normalizeContactId('line', U)
    assert.equal(r.ok, false)
    assert.match((r as { reason: string }).reason, /Provider/)
  })
  test('同一 userId 不同 Provider 得到不同标识', () => {
    const a = ok(normalizeContactId('line', U, { lineProvider: 'p1' }))
    const b = ok(normalizeContactId('line', U, { lineProvider: 'p2' }))
    assert.notEqual(a, b)
  })
  test('格式不对的 userId 拒绝', () => {
    assert.equal(normalizeContactId('line', 'Uxyz', { lineProvider: 'p1' }).ok, false)
  })
})

describe('批量归一化', () => {
  test('换行与逗号混排，自动去重并统计问题行', () => {
    const r = normalizeContactList(
      'whatsapp',
      '+8613800138000\n8613800138000\n+8615900000000, 123\n\n0138000'
    )
    assert.deepEqual(r.contactIds.sort(), ['wa:+8613800138000', 'wa:+8615900000000'])
    assert.equal(r.duplicates, 1)
    assert.equal(r.errors.length, 2)
    assert.equal(r.totalLines, 5)
  })
  test('数组输入同样可用', () => {
    const r = normalizeContactList('telegram', ['1', '2', '2'])
    assert.deepEqual(r.contactIds, ['tg:1', 'tg:2'])
    assert.equal(r.duplicates, 1)
  })
  test('错误行最多保留 50 条，避免超大响应', () => {
    const bad = Array.from({ length: 200 }, () => 'x')
    assert.equal(normalizeContactList('telegram', bad).errors.length, 50)
  })
  test('全是脏数据时返回空名单而不是抛错', () => {
    const r = normalizeContactList('whatsapp', 'abc\ndef')
    assert.deepEqual(r.contactIds, [])
  })
})

describe('channelOfContactId', () => {
  test('按前缀反推平台', () => {
    assert.equal(channelOfContactId('wa:+861'), 'whatsapp')
    assert.equal(channelOfContactId('tg:1'), 'telegram')
    assert.equal(channelOfContactId('line:p:U1'), 'line')
    assert.equal(channelOfContactId('weird'), undefined)
  })
})
