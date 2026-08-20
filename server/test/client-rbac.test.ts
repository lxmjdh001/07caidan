import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  CLIENT_PERMISSIONS,
  CLIENT_ROLE_PRESETS,
  canDelegate,
  effectiveClientPermissions,
  isClientPermission
} from '../src/client-rbac.ts'

// 客户端 RBAC 纯函数（权限校验/委派/预设）此前只在 team-rbac(HTTP)间接碰过，没直测。
// 这些是防越权/权限收敛的安全红线，直接钉死其语义。
describe('isClientPermission', () => {
  test('合法权限通过，非法/伪造字符串拒', () => {
    assert.equal(isClientPermission('billing:manage'), true)
    assert.equal(isClientPermission('accounts:manage'), true)
    assert.equal(isClientPermission('admin:*'), false) // 伪造的超权字符串
    assert.equal(isClientPermission('billing'), false)
    assert.equal(isClientPermission(''), false)
  })
})

describe('canDelegate（防越权：分配的权限必须 ⊆ 分配者自己）', () => {
  test('子集/全等可分配；超出自己的一律拒', () => {
    assert.equal(canDelegate(['billing:manage', 'team:manage'], ['billing:manage']), true) // 子集
    assert.equal(canDelegate(['billing:manage', 'team:manage'], ['billing:manage', 'team:manage']), true) // 全等
    assert.equal(canDelegate(['team:manage'], ['billing:manage']), false) // 越权：未拥有 billing
    assert.equal(canDelegate([], ['billing:manage']), false) // 无权者不能分配
    assert.equal(canDelegate(['team:manage'], []), true) // 空分配恒真
    // boss 全集 → 任意子集都可分配
    assert.equal(canDelegate([...CLIENT_PERMISSIONS], ['billing:manage', 'accounts:manage']), true)
  })
})

describe('effectiveClientPermissions（角色 ∪ 直授，去重 + 丢非法）', () => {
  test('并集去重，非法权限被过滤掉', () => {
    const p = effectiveClientPermissions(
      ['billing:manage'],
      ['billing:manage', 'team:manage', 'fake:perm', 'admin:*']
    )
    assert.deepEqual(p.sort(), ['billing:manage', 'team:manage'].sort()) // 去重 + 去掉伪造项
  })

  test('空角色 + 空直授 → 无权限', () => {
    assert.deepEqual(effectiveClientPermissions([], []), [])
  })
})

describe('CLIENT_ROLE_PRESETS', () => {
  test('boss 全权、agent 纯聊天（无任何管理权限）', () => {
    assert.deepEqual([...CLIENT_ROLE_PRESETS.boss].sort(), [...CLIENT_PERMISSIONS].sort())
    assert.deepEqual(CLIENT_ROLE_PRESETS.agent, [])
  })
})
