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
    assert.ok(r)
    assert.equal(ca.resolve(r!.token)?.email, 'a@b.com')
  })

  test('登出后令牌失效', () => {
    const r = ca.register('t1', 'a@b.com', 'secret', undefined, false)
    if (!r.ok) throw new Error('register failed')
    ca.logout(r.token)
    assert.equal(ca.resolve(r.token), null)
  })
})
