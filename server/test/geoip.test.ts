import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { regionAllowed, regionOf } from '../src/geoip/geoip.ts'
import { buildServer } from '../src/server.ts'

const RANGES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'geoip', 'ranges.json')
const V4: Array<[number, number, string]> = JSON.parse(readFileSync(RANGES_PATH, 'utf8')).v4
const ipToStr = (n: number): string => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.')

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

// 二分查找的正确性依赖数据表「按 start 升序且区间互不重叠」这一前提。gen-ranges.py 若某次
// 重新生成时破坏了这个前提（重叠/乱序），二分会静默返回错误属地——地区限制这个安全功能会失守，
// 而现有只打区间内部样例点的用例全都照过。这里守住数据不变式与区间边界判定，堵住这一整类回归。
describe('geoip 数据不变式与边界', () => {
  test('v4 表按 start 升序且区间互不重叠（二分前提）', () => {
    for (let i = 1; i < V4.length; i++) {
      assert.ok(V4[i - 1]![0] <= V4[i]![0], `#${i} 乱序：${ipToStr(V4[i - 1]![0])} > ${ipToStr(V4[i]![0])}`)
      assert.ok(V4[i - 1]![1] < V4[i]![0], `#${i} 重叠：${ipToStr(V4[i - 1]![1])} >= ${ipToStr(V4[i]![0])}`)
    }
  })

  test('每个区间的首尾 IP 都判回本区间属地（二分命中精确边界）', () => {
    for (const [s, e, r] of V4) {
      assert.equal(regionOf(ipToStr(s)), r, `区间起点 ${ipToStr(s)} 误判`)
      assert.equal(regionOf(ipToStr(e)), r, `区间终点 ${ipToStr(e)} 误判`)
    }
  })

  test('区间外邻近地址（start-1 / end+1）落到相邻区间或 other，绝不错判进本区间', () => {
    const contains = (n: number, i: number): boolean => n >= V4[i]![0] && n <= V4[i]![1]
    for (let i = 0; i < V4.length; i++) {
      const [s, e] = V4[i]!
      for (const nb of [s - 1, e + 1]) {
        if (nb < 0 || nb > 0xffffffff || contains(nb, i)) continue
        // 邻近地址不该被判进「本区间」——它要么在别的区间、要么是 other，反正不是 i 号区间独有的属地
        const got = regionOf(ipToStr(nb))
        const inOtherRange = V4.some((_, j) => j !== i && contains(nb, j))
        if (!inOtherRange) assert.equal(got, 'other', `间隙地址 ${ipToStr(nb)} 被错判为 ${got}`)
      }
    }
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
