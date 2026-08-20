import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { ClientAuthRepo } from '../src/client-auth.ts'
import { openDb } from '../src/db.ts'

let dir: string
let ca: ClientAuthRepo

describe('ClientAuthRepo', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-cauth-'))
  })
  after(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    ca = new ClientAuthRepo(openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  })

  test('无需验证时可直接注册并返回可用于同步的令牌', () => {
    const r = ca.register('t1', 'a@b.com', 'secret', undefined, false)
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.user.email, 'a@b.com')
      // 令牌可解析为该用户，租户正确
      const u = ca.resolve(r.token)
      assert.equal(u?.tenant, 't1')
    }
  })

  test('邮箱格式/弱密码/重复邮箱被拒', () => {
    assert.equal(ca.register('t1', 'bad', 'secret', undefined, false).ok, false)
    assert.equal(ca.register('t1', 'a@b.com', '123', undefined, false).ok, false)
    ca.register('t1', 'a@b.com', 'secret', undefined, false)
    const dup = ca.register('t1', 'a@b.com', 'secret', undefined, false)
    assert.equal(dup.ok, false)
  })

  test('开启验证：无码或错码注册失败，正确码成功', () => {
    const code = ca.issueCode('a@b.com')
    assert.equal(ca.register('t1', 'a@b.com', 'secret', undefined, true).ok, false)
    assert.equal(ca.register('t1', 'a@b.com', 'secret', '000000', true).ok, false)
    const ok = ca.register('t1', 'a@b.com', 'secret', code, true)
    assert.equal(ok.ok, true)
    if (ok.ok) assert.equal(ok.user.verified, true)
  })

  test('验证码用后即焚（同码不能复用）', () => {
    const code = ca.issueCode('a@b.com')
    assert.equal(ca.register('t1', 'a@b.com', 'secret', code, true).ok, true)
    // 再注册另一邮箱用旧码应失败
    assert.equal(ca.register('t1', 'c@d.com', 'secret', code, true).ok, false)
  })

  test('登录：正确密码返回令牌，错误密码/不存在返回 null', () => {
    ca.register('t1', 'a@b.com', 'secret', undefined, false)
    assert.equal(ca.login('a@b.com', 'wrong'), null)
    assert.equal(ca.login('none@b.com', 'secret'), null)
    const r = ca.login('a@b.com', 'secret')
    assert.ok(r && 'token' in r)
    if (r && 'token' in r) assert.equal(ca.resolve(r.token)?.email, 'a@b.com')
  })

  test('登出后令牌失效', () => {
    const r = ca.register('t1', 'a@b.com', 'secret', undefined, false)
    if (!r.ok) throw new Error('register failed')
    ca.logout(r.token)
    assert.equal(ca.resolve(r.token), null)
  })
})

describe('找回密码', () => {
  beforeEach(() => {
    ca = new ClientAuthRepo(openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  })

  test('正确验证码可重置，旧密码失效新密码可登录', () => {
    ca.register('t1', 'u@test.com', 'oldpass123', undefined, false)
    const code = ca.issueCode('u@test.com')
    const r = ca.resetPassword('u@test.com', code, 'newpass456')
    assert.deepEqual(r, { ok: true })
    assert.equal(ca.login('u@test.com', 'oldpass123'), null, '旧密码必须失效')
    assert.ok(ca.login('u@test.com', 'newpass456'), '新密码可登录')
  })

  test('重置成功后旧会话全部吊销 —— 改密的动机就是怀疑被盗', () => {
    const reg = ca.register('t1', 'u@test.com', 'oldpass123', undefined, false)
    assert.ok(reg.ok)
    const oldToken = reg.ok ? reg.token : ''
    assert.ok(ca.resolve(oldToken), '重置前会话有效')
    const code = ca.issueCode('u@test.com')
    ca.resetPassword('u@test.com', code, 'newpass456')
    assert.equal(ca.resolve(oldToken), null, '重置后旧会话必须失效')
  })

  test('验证码错误 / 过期 / 复用都被拒，且不泄露邮箱是否注册', () => {
    ca.register('t1', 'u@test.com', 'oldpass123', undefined, false)
    const wrong = ca.resetPassword('u@test.com', '000000', 'newpass456')
    assert.equal(wrong.ok, false)
    // 未注册邮箱返回同一句话
    const ghost = ca.resetPassword('ghost@test.com', '000000', 'newpass456')
    assert.equal(ghost.ok === false && ghost.error, wrong.ok === false && wrong.error)
    // 验证码用后即焚，不能二次使用
    const code = ca.issueCode('u@test.com')
    assert.equal(ca.resetPassword('u@test.com', code, 'newpass456').ok, true)
    assert.equal(ca.resetPassword('u@test.com', code, 'again789xx').ok, false)
  })

  test('弱密码被拒且验证码不被消耗', () => {
    ca.register('t1', 'u@test.com', 'oldpass123', undefined, false)
    const code = ca.issueCode('u@test.com')
    const r = ca.resetPassword('u@test.com', code, 'short')
    assert.equal(r.ok, false)
    // 密码校验在验码之前，验证码仍可用
    assert.equal(ca.resetPassword('u@test.com', code, 'goodpass456').ok, true)
  })

  test('hasUser 大小写不敏感', () => {
    ca.register('t1', 'u@test.com', 'password123', undefined, false)
    assert.equal(ca.hasUser('U@Test.com'), true)
    assert.equal(ca.hasUser('nobody@test.com'), false)
  })
})

describe('开发模式固定验证码（HTTP 层见 team-rbac 附带用例）', () => {
  beforeEach(() => {
    ca = new ClientAuthRepo(openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  })

  test('issueCode 传固定码则存固定码，不传则随机 6 位', () => {
    const fixed = ca.issueCode('a@b.com', '12345')
    assert.equal(fixed, '12345')
    assert.equal(ca.register('t1', 'a@b.com', 'password1', '12345', true).ok, true)
    const rand = ca.issueCode('c@d.com')
    assert.match(rand, /^\d{6}$/)
  })

  test('revokeDevice：吊销某设备会话 → 该令牌立即失效', () => {
    const r = ca.register('t1', 'boss@t.com', 'secret', undefined, false, { deviceId: 'devA' })
    assert.ok(r.ok)
    if (!r.ok) return
    assert.ok(ca.resolve(r.token), '吊销前令牌有效')
    assert.equal(ca.revokeDevice(r.user, 'devA'), 1)
    assert.equal(ca.resolve(r.token), null, '设备下线后令牌失效')
  })

  test('停用子账号 → 其会话立即吊销、且不能再登录', () => {
    const boss = ca.register('t1', 'boss2@t.com', 'secret', undefined, false)
    assert.ok(boss.ok)
    if (!boss.ok) return
    const m = ca.createMember(boss.user, 'agent1', 'agentpass1', 'agent')
    assert.ok(m.ok)
    if (!m.ok) return
    const login = ca.login(m.member.email, 'agentpass1')
    assert.ok(login && 'token' in login)
    if (!login || !('token' in login)) return
    assert.ok(ca.resolve(login.token), '停用前会话有效')
    // 停用（updateMember enabled:false 会连带吊销会话）
    assert.ok(ca.updateMember(boss.user, m.member.id, { enabled: false }).ok)
    assert.equal(ca.resolve(login.token), null, '停用即吊销会话（防离职客服继续用旧令牌）')
    assert.equal(ca.login(m.member.email, 'agentpass1'), null, '停用后不能再登录')
  })
})
