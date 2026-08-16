import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { openDb } from '../src/db.ts'
import { LineRelay } from '../src/line-relay.ts'

let dir: string
let relay: LineRelay

describe('LineRelay', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-line-'))
  })
  after(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    relay = new LineRelay(openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  })

  test('注册后可查到 channelSecret', () => {
    relay.register('t1', 'line1', 'secret')
    assert.equal(relay.lookup('t1', 'line1')?.channelSecret, 'secret')
    assert.equal(relay.lookup('t1', 'nope'), null)
  })

  test('签名验证：正确签名通过，错误拒绝', () => {
    const body = JSON.stringify({ events: [{ type: 'message' }] })
    const sig = createHmac('sha256', 'secret').update(body).digest('base64')
    assert.equal(relay.verifySignature('secret', body, sig), true)
    assert.equal(relay.verifySignature('secret', body, 'wrong'), false)
    assert.equal(relay.verifySignature('other', body, sig), false)
  })

  test('入队后拉取返回并清空（幂等消费）', () => {
    relay.enqueue('t1', 'line1', [{ id: 1 }, { id: 2 }])
    const first = relay.pull('t1', 'line1')
    assert.equal(first.length, 2)
    assert.equal(relay.pull('t1', 'line1').length, 0) // 已清空
  })

  test('租户/账号隔离', () => {
    relay.enqueue('t1', 'line1', [{ id: 1 }])
    assert.equal(relay.pull('t2', 'line1').length, 0)
    assert.equal(relay.pull('t1', 'line2').length, 0)
    assert.equal(relay.pull('t1', 'line1').length, 1)
  })
})

describe('批量拉取', () => {
  const T = 't1'
  // 上面的 describe 钩子不作用于此，自建库
  beforeEach(() => {
    relay = new LineRelay(openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  })

  test('一次拉取全部账号，按账号分组，队列清空', () => {
    relay.register(T, 'a1', 'secret1')
    relay.register(T, 'a2', 'secret2')
    relay.enqueue(T, 'a1', [{ n: 1 }, { n: 2 }])
    relay.enqueue(T, 'a2', [{ n: 3 }])

    const all = relay.pullAll(T)
    assert.deepEqual(all.a1, [{ n: 1 }, { n: 2 }])
    assert.deepEqual(all.a2, [{ n: 3 }])
    // 再拉为空 —— 事件只交付一次
    assert.deepEqual(relay.pullAll(T), {})
  })

  test('租户隔离：别的租户拉不走我的事件', () => {
    relay.enqueue(T, 'a1', [{ n: 1 }])
    assert.deepEqual(relay.pullAll('other'), {})
    assert.equal(relay.pullAll(T).a1?.length, 1)
  })

  test('保序：同账号事件按入队顺序返回', () => {
    relay.enqueue(T, 'a1', [{ n: 1 }])
    relay.enqueue(T, 'a1', [{ n: 2 }])
    relay.enqueue(T, 'a1', [{ n: 3 }])
    assert.deepEqual(
      (relay.pullAll(T).a1 as Array<{ n: number }>).map((e) => e.n),
      [1, 2, 3]
    )
  })

  test('超龄清理：三天没人拉的事件被丢弃，新事件保留', () => {
    const now = Date.now()
    relay.enqueue(T, 'a1', [{ old: true }])
    // 手动把这条改老（模拟三天前入队）
    const pruned0 = relay.pruneStale(T, 3 * 86_400_000, now + 4 * 86_400_000)
    assert.equal(pruned0, 1)
    relay.enqueue(T, 'a1', [{ fresh: true }])
    assert.equal(relay.pruneStale(T, 3 * 86_400_000, now), 0)
    assert.equal(relay.pullAll(T).a1?.length, 1)
  })
})
