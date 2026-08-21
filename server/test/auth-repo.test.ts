import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { openDb } from '../src/db.ts'
import { AuthRepo } from '../src/auth-repo.ts'
import { sessions } from '../src/schema.ts'

const T = 'dev-token'
let dir: string
let db: ReturnType<typeof openDb>
let auth: AuthRepo
let userId: number

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-auth-')) })
after(() => { rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  db = openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`))
  auth = new AuthRepo(db)
  userId = auth.createUser(T, 'admin', 'pw123456', 'owner', []).id
})

describe('AuthRepo 会话生命周期与安全', () => {
  test('登录成功→resolve 得到 principal；错密码/不存在→null', () => {
    const r = auth.login('admin', 'pw123456')
    assert.ok(r)
    assert.equal(auth.resolve(r!.token)?.username, 'admin')
    assert.equal(auth.login('admin', 'wrong-pw'), null)
    assert.equal(auth.login('ghost', 'pw123456'), null)
  })

  test('会话过期 → resolve 拒绝（安全红线）；pruneSessions 删掉过期会话', () => {
    const r = auth.login('admin', 'pw123456')!
    // 直接把会话改成已过期
    db.update(sessions).set({ expiresAt: Date.now() - 1000 }).where(eq(sessions.token, r.token)).run()
    assert.equal(auth.resolve(r.token), null) // 过期令牌绝不认证
    assert.equal(db.select().from(sessions).all().length, 1) // 清理前仍在表里
    auth.pruneSessions()
    assert.equal(db.select().from(sessions).all().length, 0) // 清理后删除
  })

  test('用户被停用 → 即便会话有效，resolve 也返回 null', () => {
    const r = auth.login('admin', 'pw123456')!
    assert.ok(auth.resolve(r.token)) // 停用前有效
    auth.updateUser(T, userId, { enabled: false })
    assert.equal(auth.resolve(r.token), null) // 停用即失效（不等会话过期）
  })

  test('停用的用户无法再登录', () => {
    auth.updateUser(T, userId, { enabled: false })
    assert.equal(auth.login('admin', 'pw123456'), null)
  })

  test('logout → 令牌立即失效', () => {
    const r = auth.login('admin', 'pw123456')!
    auth.logout(r.token)
    assert.equal(auth.resolve(r.token), null)
  })

  test('改密后旧会话立即吊销（改密动机常是号被盗，留旧会话等于白改）', () => {
    const r = auth.login('admin', 'pw123456')!
    assert.ok(auth.resolve(r.token)) // 改密前有效
    auth.updateUser(T, userId, { password: 'newpw678901' })
    assert.equal(auth.resolve(r.token), null, '改密必须吊销旧会话')
    // 会话行也确实被删（不是只靠 resolve 挡）
    assert.equal(db.select().from(sessions).where(eq(sessions.userId, userId)).all().length, 0)
    // 新密码可正常登录
    assert.ok(auth.login('admin', 'newpw678901'))
  })

  test('停用会连带删除其会话行（不留悬空会话）', () => {
    const r = auth.login('admin', 'pw123456')!
    auth.updateUser(T, userId, { enabled: false })
    assert.equal(auth.resolve(r.token), null)
    assert.equal(db.select().from(sessions).where(eq(sessions.userId, userId)).all().length, 0)
  })

  test('只改角色/权限不动会话（不该无谓踢人下线）', () => {
    const r = auth.login('admin', 'pw123456')!
    auth.updateUser(T, userId, { role: 'admin' })
    assert.ok(auth.resolve(r.token), '改权限不该吊销会话')
  })
})
