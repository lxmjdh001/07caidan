import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
// @ts-expect-error —— 纯 JS 脚本，无类型声明
import { coverage, extractKeys } from '../../scripts/i18n-coverage-core.mjs'

describe('i18n 覆盖率核心', () => {
  test('extractKeys 抽取所有键名', () => {
    const src = `export const x = {\n  'a.b': 'v',\n  'c.d': '值',\n  'e': 'x',\n}`
    const keys = extractKeys(src)
    assert.equal(keys.size, 3)
    assert.ok(keys.has('a.b') && keys.has('c.d') && keys.has('e'))
  })

  test('coverage 计算缺失与百分比', () => {
    const canon = new Set(['a', 'b', 'c', 'd'])
    const loc = new Set(['a', 'b'])
    const c = coverage(canon, loc)
    assert.equal(c.total, 4)
    assert.equal(c.present, 2)
    assert.deepEqual(c.missing, ['c', 'd'])
    assert.equal(c.pct, 50)
  })

  test('全覆盖 = 100%、无缺失', () => {
    const canon = new Set(['a', 'b'])
    const c = coverage(canon, new Set(['a', 'b', 'extra']))
    assert.equal(c.pct, 100)
    assert.deepEqual(c.missing, [])
  })

  test('空规范集不除零', () => {
    assert.equal(coverage(new Set(), new Set()).pct, 100)
  })
})
