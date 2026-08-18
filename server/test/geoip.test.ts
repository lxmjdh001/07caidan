import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { regionAllowed, regionOf } from '../src/geoip/geoip.ts'
import { buildServer } from '../src/server.ts'

const TOKEN = 'dev-token'
// 样例取自 APNIC 数据首段，属地稳定
const CN_IP = '1.0.1.1'
const HK_IP = '1.36.0.1'
const US_IP = '8.8.8.8'

describe('regionOf', () => {
  test('IPv4 属地判定', () => {
    assert.equal(regionOf(CN_IP), 'CN')
    assert.equal(regionOf(HK_IP), 'HK')
    assert.equal(regionOf(US_IP), 'other')
    assert.equal(regionOf('127.0.0.1'), 'other')
  })

  test('IPv4 映射地址（::ffff:）', () => {
    assert.equal(regionOf(`::ffff:${CN_IP}`), 'CN')
    assert.equal(regionOf(`::ffff:${US_IP}`), 'other')
  })

  test('IPv6 属地判定', () => {
    assert.equal(regionOf('2001:250::1'), 'CN')
    assert.equal(regionOf('2001:2e0::1'), 'HK')
    assert.equal(regionOf('2606:4700::1111'), 'other')
    assert.equal(regionOf('::1'), 'other')
  })

  test('非法输入不抛异常', () => {
    assert.equal(regionOf('not-an-ip'), 'other')
    assert.equal(regionOf(''), 'other')
  })
})

describe('regionAllowed', () => {
  test('默认拒绝 CN/HK，放行其他；开关逐项生效', () => {
    const deny = { allowCn: false, allowHk: false }
    assert.equal(regionAllowed(CN_IP, deny), false)
    assert.equal(regionAllowed(HK_IP, deny), false)
    assert.equal(regionAllowed(US_IP, deny), true)
    assert.equal(regionAllowed(CN_IP, { allowCn: true, allowHk: false }), true)
    assert.equal(regionAllowed(HK_IP, { allowCn: false, allowHk: true }), true)
  })
})

describe('公开看板地区限制（HTTP）', () => {
  let dir: string
  let app: FastifyInstance

  function makeConfig(dbPath: string): ServerConfig {
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

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-geo-'))
  })
  after(async () => {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await app?.close()
    app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
    await app.ready()
  })

  async function makeLink(allow: Record<string, unknown> = {}): Promise<string> {
    const c = await app.inject({
      method: 'POST',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { name: 'x', accountIds: ['a1'], startAt: Date.now(), ...allow }
    })
    const id = c.json().campaign.id
    const l = await app.inject({
      method: 'POST',
      url: `/api/campaigns/${id}/links`,
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    return l.json().link.token
  }

  test('默认：CN/HK 访问 403，海外访问 200', async () => {
    const token = await makeLink()
    const cn = await app.inject({ url: `/public/campaign/${token}`, remoteAddress: CN_IP })
    assert.equal(cn.statusCode, 403)
    assert.equal(cn.json().error, 'region_blocked')
    const hk = await app.inject({ url: `/public/campaign/${token}`, remoteAddress: HK_IP })
    assert.equal(hk.statusCode, 403)
    const us = await app.inject({ url: `/public/campaign/${token}`, remoteAddress: US_IP })
    assert.equal(us.statusCode, 200)
    // 页面本身也拦
    const page = await app.inject({ url: `/c/${token}`, remoteAddress: CN_IP })
    assert.equal(page.statusCode, 403)
  })

  test('放开大陆后 CN 200、HK 仍 403；PATCH 可改', async () => {
    const token = await makeLink({ allowCnIp: true })
    assert.equal(
      (await app.inject({ url: `/public/campaign/${token}`, remoteAddress: CN_IP })).statusCode,
      200
    )
    assert.equal(
      (await app.inject({ url: `/public/campaign/${token}`, remoteAddress: HK_IP })).statusCode,
      403
    )
    // 再放开香港
    const c = await app.inject({
      method: 'GET',
      url: '/api/campaigns',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const id = c.json().campaigns[0].id
    await app.inject({
      method: 'PATCH',
      url: `/api/campaigns/${id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { allowHkIp: true }
    })
    assert.equal(
      (await app.inject({ url: `/public/campaign/${token}`, remoteAddress: HK_IP })).statusCode,
      200
    )
  })
})
