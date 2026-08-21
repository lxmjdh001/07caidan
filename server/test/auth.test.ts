import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { AuthRepo } from '../src/auth-repo.ts'
import { PERMISSIONS, ROLE_PRESETS, effectivePermissions, hashPassword, verifyPassword } from '../src/auth.ts'
import { openDb } from '../src/db.ts'

let dir: string
let auth: AuthRepo

describe('auth 基础', () => {
  test('密码哈希可验证，错误密码不通过', () => {
    const h = hashPassword('s3cret')
    assert.equal(verifyPassword('s3cret', h), true)
    assert.equal(verifyPassword('wrong', h), false)
  })

  test('有效权限 = 角色预设 ∪ 额外分配（去重、忽略非法）', () => {
    const p = effectivePermissions('viewer', ['analyze:run', 'bogus:perm'])
    assert.deepEqual([...p].sort(), ['analyze:run', 'conversations:read'])
  })

  test('owner 角色含全部权限', () => {
    assert.equal(effectivePermissions('owner', []).includes('users:manage'), true)
  })

  test('安全不变式：任何含 users:manage 的角色必须拥有全部权限（否则可越权造号）', () => {
    // 后台建用户路由不做委派校验（不像客户端 canDelegate）。这是安全的前提是：
    // 只有「已拥有全部权限」的角色才有 users:manage —— 否则它能造出权限比自己大的号（提权）。
    // 若日后有人给某角色加 users:manage 却不给全权，这条会红，挡住提权漏洞。
    for (const [role, perms] of Object.entries(ROLE_PRESETS)) {
      if ((perms as string[]).includes('users:manage')) {
        for (const p of PERMISSIONS) {
          assert.ok((perms as string[]).includes(p), `角色 ${role} 有 users:manage 却缺 ${p} → 可越权造号`)
        }
      }
    }
  })
})

describe('AuthRepo', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-auth-'))
  })
  after(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    auth = new AuthRepo(openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  })

  test('bootstrap 仅在无用户时创建 owner', () => {
    auth.bootstrap('t1', 'admin', 'pw')
    auth.bootstrap('t1', 'admin', 'pw') // 第二次应无效果
    assert.equal(auth.listUsers('t1').length, 1)
    assert.equal(auth.listUsers('t1')[0]?.role, 'owner')
  })

  test('登录成功返回 token 与有效权限，错误密码/停用被拒', () => {
    auth.bootstrap('t1', 'admin', 'pw')
    assert.equal(auth.login('admin', 'wrong'), null)
    const r = auth.login('admin', 'pw')
    assert.ok(r)
    assert.equal(r!.principal.username, 'admin')
    assert.ok(r!.principal.permissions.includes('users:manage'))
    // token 可解析
    const p = auth.resolve(r!.token)
    assert.equal(p?.username, 'admin')
  })

  test('创建普通用户 + 分配额外权限，登录后权限合并生效', () => {
    auth.bootstrap('t1', 'admin', 'pw')
    auth.createUser('t1', 'kefu', 'pw2', 'viewer', ['analyze:run'])
    const r = auth.login('kefu', 'pw2')
    assert.ok(r)
    assert.deepEqual(
      [...r!.principal.permissions].sort(),
      ['analyze:run', 'conversations:read']
    )
  })

  test('停用用户后无法登录，且已发 token 失效', () => {
    auth.bootstrap('t1', 'admin', 'pw')
    const u = auth.createUser('t1', 'kefu', 'pw2', 'agent', [])
    const r = auth.login('kefu', 'pw2')!
    auth.updateUser('t1', u.id, { enabled: false })
    assert.equal(auth.login('kefu', 'pw2'), null)
    assert.equal(auth.resolve(r.token), null) // 已发会话也失效
  })

  test('登出后 token 失效', () => {
    auth.bootstrap('t1', 'admin', 'pw')
    const r = auth.login('admin', 'pw')!
    auth.logout(r.token)
    assert.equal(auth.resolve(r.token), null)
  })

  test('删除用户', () => {
    auth.bootstrap('t1', 'admin', 'pw')
    const u = auth.createUser('t1', 'kefu', 'pw2', 'agent', [])
    assert.equal(auth.deleteUser('t1', u.id), true)
    assert.equal(auth.listUsers('t1').length, 1)
  })

  test('租户隔离：t2 看不到 t1 用户', () => {
    auth.bootstrap('t1', 'admin', 'pw')
    assert.equal(auth.listUsers('t2').length, 0)
  })
})
