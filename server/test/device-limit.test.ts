import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { ClientAuthRepo, type ClientUser } from '../src/client-auth.ts'
import { openDb } from '../src/db.ts'

let dir: string
let ca: ClientAuthRepo

/** 注册一个老板并返回其 ClientUser（用 resolve 拿到 id/ownerId） */
function registerBoss(email: string): ClientUser {
  const r = ca.register('t1', email, 'secret123', undefined, false)
  assert.ok(r.ok)
  const u = ca.resolve(r.ok ? r.token : '')
  assert.ok(u)
  return u!
}

describe('设备管理（订阅限 N 台 + 远程下线）', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-dev-'))
  })
  after(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    ca = new ClientAuthRepo(openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  })

  test('上限=0（不限）时任意设备都能登录', () => {
    ca.deviceQuotaResolver = () => 0
    registerBoss('a@b.com')
    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      const r = ca.login('a@b.com', 'secret123', { deviceId: id, deviceName: id })
      assert.ok(r && 'token' in r, `${id} 应能登录`)
    }
  })

  test('达到上限后新设备被拒，返回当前设备列表', () => {
    ca.deviceQuotaResolver = () => 2
    registerBoss('a@b.com')
    // 注册本身不占设备名额（新用户无订阅），但会记录注册设备。这里用两次登录占满 2 台
    assert.ok('token' in ca.login('a@b.com', 'secret123', { deviceId: 'd1', deviceName: 'PC-1' })!)
    assert.ok('token' in ca.login('a@b.com', 'secret123', { deviceId: 'd2', deviceName: 'PC-2' })!)
    const blocked = ca.login('a@b.com', 'secret123', { deviceId: 'd3', deviceName: 'PC-3' })
    assert.ok(blocked && 'deviceLimit' in blocked, '第 3 台应被拒')
    if (blocked && 'deviceLimit' in blocked) {
      assert.equal(blocked.maxDevices, 2)
      assert.equal(blocked.devices.length, 2)
      assert.deepEqual(blocked.devices.map((d) => d.deviceId).sort(), ['d1', 'd2'])
    }
  })

  test('已在册设备重复登录不占新名额', () => {
    ca.deviceQuotaResolver = () => 1
    registerBoss('a@b.com')
    assert.ok('token' in ca.login('a@b.com', 'secret123', { deviceId: 'd1' })!)
    // 同一设备再次登录：仍放行（多开会话仍算 1 台）
    assert.ok('token' in ca.login('a@b.com', 'secret123', { deviceId: 'd1' })!)
    // 换新设备则被拒
    const blocked = ca.login('a@b.com', 'secret123', { deviceId: 'd2' })
    assert.ok(blocked && 'deviceLimit' in blocked)
  })

  test('无 deviceId 的老客户端不受限（放行且不计数）', () => {
    ca.deviceQuotaResolver = () => 1
    registerBoss('a@b.com')
    assert.ok('token' in ca.login('a@b.com', 'secret123', { deviceId: 'd1' })!)
    // 不带 deviceId：即使已满也放行
    assert.ok('token' in ca.login('a@b.com', 'secret123')!)
    assert.ok('token' in ca.login('a@b.com', 'secret123', {})!)
  })

  test('远程下线后腾出名额，新设备可登录', () => {
    ca.deviceQuotaResolver = () => 1
    const boss = registerBoss('a@b.com')
    assert.ok('token' in ca.login('a@b.com', 'secret123', { deviceId: 'd1', deviceName: 'PC-1' })!)
    assert.ok('deviceLimit' in ca.login('a@b.com', 'secret123', { deviceId: 'd2' })!)
    const revoked = ca.revokeDevice(boss, 'd1')
    assert.ok(revoked >= 1, '应吊销 d1 的会话')
    // d1 名额已释放，d2 现在可登录
    assert.ok('token' in ca.login('a@b.com', 'secret123', { deviceId: 'd2' })!)
    // d1 被下线后其会话失效
    assert.equal(ca.listDevices(boss).some((d) => d.deviceId === 'd1'), false)
  })

  test('listDevices 聚合去重并标记当前设备', () => {
    ca.deviceQuotaResolver = () => 5
    const boss = registerBoss('a@b.com')
    const s1 = ca.login('a@b.com', 'secret123', { deviceId: 'd1', deviceName: 'PC-1' })
    ca.login('a@b.com', 'secret123', { deviceId: 'd2', deviceName: 'Mac-2' })
    ca.login('a@b.com', 'secret123', { deviceId: 'd1', deviceName: 'PC-1' }) // d1 多开
    const token = s1 && 'token' in s1 ? s1.token : ''
    const list = ca.listDevices(boss, token)
    assert.equal(list.length, 2, '两台去重后的设备')
    const d1 = list.find((d) => d.deviceId === 'd1')!
    assert.equal(d1.sessions, 2, 'd1 有两个会话')
    assert.equal(d1.current, true, 'd1 是当前请求设备')
  })

  test('子账号与老板共享同一设备池', () => {
    ca.deviceQuotaResolver = () => 1
    const boss = registerBoss('a@b.com')
    const m = ca.createMember(boss, 'agent1', 'agentpass1', 'agent')
    assert.ok(m.ok)
    // 老板先占满 1 台
    assert.ok('token' in ca.login('a@b.com', 'secret123', { deviceId: 'd1' })!)
    // 子账号从新设备登录：共享池已满 → 被拒
    const blocked = ca.login('agent1@' + boss.id, 'agentpass1', { deviceId: 'd2' })
    assert.ok(blocked && 'deviceLimit' in blocked, '子账号应受老板设备池限制')
  })

  test('跨老板隔离：不能下线别的老板的设备', () => {
    ca.deviceQuotaResolver = () => 5
    const bossA = registerBoss('a@b.com')
    const bossB = registerBoss('b@b.com')
    ca.login('a@b.com', 'secret123', { deviceId: 'da', deviceName: 'A-PC' })
    ca.login('b@b.com', 'secret123', { deviceId: 'db', deviceName: 'B-PC' })
    // A 尝试下线 B 的设备 → 无效
    assert.equal(ca.revokeDevice(bossA, 'db'), 0)
    assert.equal(ca.listDevices(bossB).some((d) => d.deviceId === 'db'), true)
    // B 下线自己的设备 → 生效
    assert.ok(ca.revokeDevice(bossB, 'db') >= 1)
  })
})
