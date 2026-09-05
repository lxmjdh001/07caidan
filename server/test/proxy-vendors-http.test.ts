import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const TOKEN = 'proxy-vendor-test-token'
let dir: string
let app: FastifyInstance

function config(dbPath: string): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath,
    mediaDir: join(dir, 'media'),
    tokens: [TOKEN],
    anthropicApiKey: undefined,
    analysisModel: 'claude-opus-5',
    adminUser: 'admin',
    adminPassword: 'admin',
    adminTenant: TOKEN,
    requireEmailVerify: false,
    clientTenant: TOKEN,
    smtp: undefined,
    publicUrl: 'http://localhost:8787',
    updatesDir: join(dir, 'updates'),
    crispWebsiteId: undefined
  }
}

async function call(method: string, url: string, token?: string, body?: unknown) {
  const response = await app.inject({
    method: method as 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object })
  })
  return { status: response.statusCode, json: response.json() as Record<string, any> }
}

async function adminToken(): Promise<string> {
  const result = await call('POST', '/api/login', undefined, { username: 'admin', password: 'admin' })
  return result.json.token as string
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-proxy-vendors-')) })
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  await app?.close()
  app = buildServer(config(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
})

describe('代理供应商目录', () => {
  test('客户端只看到已上架项目，并可按全球/中国分类筛选', async () => {
    assert.equal((await call('GET', '/api/proxy-vendors?region=global')).status, 401)

    const global = await call('GET', '/api/proxy-vendors?region=global', TOKEN)
    const china = await call('GET', '/api/proxy-vendors?region=china', TOKEN)
    assert.equal(global.status, 200)
    assert.equal(china.status, 200)
    assert.ok(global.json.vendors.length > 0)
    assert.ok(china.json.vendors.length > 0)
    assert.ok(global.json.vendors.every((vendor: { region: string; enabled: boolean }) => vendor.region === 'global' && vendor.enabled))
    assert.ok(china.json.vendors.every((vendor: { region: string; enabled: boolean }) => vendor.region === 'china' && vendor.enabled))
    assert.ok(global.json.vendors.some((vendor: { name: string }) => vendor.name === '1024proxy'))
    assert.ok(global.json.vendors.some((vendor: { name: string }) => vendor.name === 'ZooProxy'))
    assert.ok(china.json.vendors.some((vendor: { name: string }) => vendor.name === '快代理'))
    assert.ok(china.json.vendors.some((vendor: { name: string }) => vendor.name === '花生 HTTP'))
  })

  test('后台可新增、编辑、排序、上下架与删除', async () => {
    const token = await adminToken()
    const created = await call('POST', '/api/admin/proxy-vendors', token, {
      name: '测试代理',
      region: 'global',
      summary: '测试简介',
      purchaseUrl: 'https://proxy.example/buy',
      logoUrl: 'https://proxy.example/logo.png',
      badge: '推荐',
      buttonLabel: '一键购买',
      enabled: false,
      recommended: true,
      sortOrder: -10
    })
    assert.equal(created.status, 200)
    const id = created.json.vendor.id as string

    const hidden = await call('GET', '/api/proxy-vendors?region=global', TOKEN)
    assert.ok(!hidden.json.vendors.some((vendor: { id: string }) => vendor.id === id))

    assert.equal((await call('PATCH', `/api/admin/proxy-vendors/${id}`, token, {
      enabled: true,
      name: '测试代理新版',
      sortOrder: -20
    })).status, 200)

    const visible = await call('GET', '/api/proxy-vendors?region=global', TOKEN)
    assert.equal(visible.json.vendors[0].id, id)
    assert.equal(visible.json.vendors[0].name, '测试代理新版')

    assert.equal((await call('DELETE', `/api/admin/proxy-vendors/${id}`, token)).status, 200)
    const removed = await call('GET', '/api/proxy-vendors?region=global', TOKEN)
    assert.ok(!removed.json.vendors.some((vendor: { id: string }) => vendor.id === id))
  })

  test('拒绝脚本链接和无效分类', async () => {
    const token = await adminToken()
    const badUrl = await call('POST', '/api/admin/proxy-vendors', token, {
      name: '危险链接',
      region: 'global',
      purchaseUrl: 'javascript:alert(1)'
    })
    assert.equal(badUrl.status, 400)

    const badRegion = await call('GET', '/api/proxy-vendors?region=other', TOKEN)
    assert.equal(badRegion.status, 400)
  })
})
