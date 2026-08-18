import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
// @ts-expect-error —— 纯 JS 校验脚本，无类型声明
import { validateBrand } from '../../scripts/brand-schema.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const brandingDir = join(here, '..', '..', 'branding')

function full(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appName: 'Acme',
    shortName: 'acme',
    logoText: 'AC',
    company: 'Acme Inc',
    supportEmail: '',
    dashboardTitle: '看板',
    apiUrl: 'https://api.acme.com',
    themeColor: '#7c3aed',
    ...over
  }
}

describe('品牌配置校验', () => {
  test('仓库内所有品牌都合规', () => {
    for (const file of ['default.json', 'e2e.json']) {
      const obj = JSON.parse(readFileSync(join(brandingDir, file), 'utf8'))
      assert.deepEqual(validateBrand(file, obj), [], `${file} 应无错误`)
    }
  })

  test('完整合规对象通过', () => {
    assert.deepEqual(validateBrand('x', full()), [])
  })

  test('必填字段缺失/空 → 报错', () => {
    assert.ok(validateBrand('x', full({ appName: '' })).some((e: string) => e.includes('appName')))
    const noApi = full()
    delete noApi.apiUrl
    assert.ok(validateBrand('x', noApi).some((e: string) => e.includes('apiUrl')))
  })

  test('shortName 必须是 appId/npm 安全 slug', () => {
    assert.ok(validateBrand('x', full({ shortName: 'Bad_Name!' })).some((e: string) => e.includes('shortName')))
    assert.deepEqual(validateBrand('x', full({ shortName: 'acme-crm' })), [])
  })

  test('themeColor 必须是十六进制颜色', () => {
    assert.ok(validateBrand('x', full({ themeColor: 'purple' })).some((e: string) => e.includes('themeColor')))
    assert.deepEqual(validateBrand('x', full({ themeColor: '#abc' })), [])
  })

  test('apiUrl 必须是 http(s) URL', () => {
    assert.ok(validateBrand('x', full({ apiUrl: 'ftp://x' })).some((e: string) => e.includes('apiUrl')))
  })

  test('未知字段（拼写错误）被挡下', () => {
    assert.ok(validateBrand('x', full({ appNme: 'typo' })).some((e: string) => e.includes('appNme')))
  })

  test('supportEmail 可为空，但非空须合法', () => {
    assert.deepEqual(validateBrand('x', full({ supportEmail: '' })), [])
    assert.ok(validateBrand('x', full({ supportEmail: 'nope' })).some((e: string) => e.includes('supportEmail')))
  })
})
