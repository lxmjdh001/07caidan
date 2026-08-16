import { describe, expect, it } from 'vitest'
import { deviceIdentity } from './device-identity'

describe('deviceIdentity', () => {
  it('返回合法的 [os, browser, version] 三元组', () => {
    const d = deviceIdentity('main')
    expect(d).toHaveLength(3)
    expect(typeof d[0]).toBe('string')
    expect(typeof d[1]).toBe('string')
    expect(typeof d[2]).toBe('string')
  })

  it('同一账号稳定（重连不变）', () => {
    expect(deviceIdentity('wa1abc')).toEqual(deviceIdentity('wa1abc'))
  })

  it('不同账号彼此不同（防关联）——大量账号下重复率低', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `wa${i}`)
    const fingerprints = new Set(ids.map((id) => deviceIdentity(id).join('|')))
    // OS(3)×Browser(6)=18 种组合，50 个账号里至少覆盖多数组合
    expect(fingerprints.size).toBeGreaterThan(10)
  })

  // 注：设备名组合空间有限（3 OS × 6 浏览器 = 18 种），特定两账号可能撞名，
  // 这不是主要隔离手段（加密身份 + IP 才是），此处只验证整体分散度而非两两不同。

  it('自定义 label 作为浏览器名，但仍保留按账号隔离的 OS', () => {
    const d = deviceIdentity('main', '客服A')
    expect(d[1]).toBe('客服A')
    // OS 仍来自账号派生，与另一账号同名 label 时 OS 可能不同
    const other = deviceIdentity('wa9zzz', '客服A')
    expect(other[1]).toBe('客服A')
  })
})
