import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const TOKEN = 'dev-token'
const DEVICE = 'a'.repeat(16)

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

async function api(
  method: string,
  url: string,
  body?: unknown,
  token: string | null = null
): Promise<{ status: number; json: any }> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object })
  })
  let json: any = {}
  try {
    json = res.json()
  } catch {
    json = { raw: res.body }
  }
  return { status: res.statusCode, json }
}

async function adminToken(): Promise<string> {
  const r = await api('POST', '/api/login', { username: 'admin', password: 'admin' })
  return r.json.token
}

function entry(level: string, message: string, extra: Record<string, unknown> = {}) {
  return { level, message, scope: 'test', at: Date.now(), ...extra }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-logs-'))
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

describe('客户端日志上报', () => {
  test('游客无令牌也能上报（登录前崩溃最需要日志）', async () => {
    const r = await api('POST', '/api/logs', {
      deviceId: DEVICE,
      appVersion: '1.2.3',
      osType: 'darwin',
      osVersion: '25.5.0',
      entries: [entry('error', '启动崩溃', { meta: { stack: 'x' } })]
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.added, 1)
    assert.equal(r.json.level, 'warn', '游客默认 warn')
  })

  test('登录用户上报会关联账号；响应带回其目标级别', async () => {
    const reg = await api('POST', '/api/client/register', {
      email: 'u@t.com',
      password: 'password123'
    })
    const r = await api(
      'POST',
      '/api/logs',
      { deviceId: DEVICE, entries: [entry('warn', '断线重连')] },
      reg.json.token
    )
    assert.equal(r.json.level, 'warn')

    const admin = await adminToken()
    const list = await api('GET', '/api/admin/logs', undefined, admin)
    assert.equal(list.status, 200)
    const row = list.json.logs.find((l: any) => l.message === '断线重连')
    assert.ok(row)
    assert.equal(row.email, 'u@t.com', '日志关联到上报用户的邮箱')
  })

  test('参数校验：deviceId 格式、entries 上限、非法级别丢弃', async () => {
    assert.equal((await api('POST', '/api/logs', { entries: [] })).status, 400)
    assert.equal(
      (await api('POST', '/api/logs', { deviceId: 'zz!!', entries: [] })).status,
      400
    )
    const tooMany = await api('POST', '/api/logs', {
      deviceId: DEVICE,
      entries: Array.from({ length: 201 }, () => entry('warn', 'x'))
    })
    assert.equal(tooMany.status, 400)
    const mixed = await api('POST', '/api/logs', {
      deviceId: DEVICE,
      entries: [entry('warn', 'ok'), entry('fatal', 'bad'), { message: 'no-level' }]
    })
    assert.equal(mixed.json.added, 1, '非法级别静默丢弃，合法的照收')
  })

  test('管理设置某用户级别为 debug 后，上报响应立刻带回新级别', async () => {
    const reg = await api('POST', '/api/client/register', {
      email: 'u@t.com',
      password: 'password123'
    })
    const admin = await adminToken()
    // 先报一条拿 userId
    await api('POST', '/api/logs', { deviceId: DEVICE, entries: [entry('warn', 'x')] }, reg.json.token)
    const devices = await api('GET', '/api/admin/logs/devices', undefined, admin)
    const userId = devices.json.devices[0].userId
    assert.ok(typeof userId === 'number')

    const set = await api('POST', '/api/admin/logs/level', { userId, level: 'debug' }, admin)
    assert.equal(set.status, 200)
    const r = await api(
      'POST',
      '/api/logs',
      { deviceId: DEVICE, entries: [entry('debug', 'verbose on')] },
      reg.json.token
    )
    assert.equal(r.json.level, 'debug')
  })

  test('过滤：按级别查 warn 时包含 error（更严重的当然要看）', async () => {
    await api('POST', '/api/logs', {
      deviceId: DEVICE,
      entries: [entry('info', 'i1'), entry('warn', 'w1'), entry('error', 'e1')]
    })
    const admin = await adminToken()
    const warnUp = await api('GET', '/api/admin/logs?level=warn', undefined, admin)
    const msgs = warnUp.json.logs.map((l: any) => l.message).sort()
    assert.deepEqual(msgs, ['e1', 'w1'])
    const q = await api('GET', '/api/admin/logs?q=e1', undefined, admin)
    assert.equal(q.json.logs.length, 1)
  })

  test('设备概览聚合版本、系统与错误计数', async () => {
    await api('POST', '/api/logs', {
      deviceId: DEVICE,
      appVersion: '1.0.0',
      osType: 'win32',
      osVersion: '10.0.22631',
      entries: [entry('error', 'boom'), entry('warn', 'meh')]
    })
    const admin = await adminToken()
    const r = await api('GET', '/api/admin/logs/devices', undefined, admin)
    const d = r.json.devices[0]
    assert.equal(d.deviceId, DEVICE)
    assert.equal(d.osType, 'win32')
    assert.equal(d.total, 2)
    assert.equal(d.errors, 1)
  })

  test('日志接口需要 support:manage；无权限管理员被拒', async () => {
    // 静态同步令牌不是管理员 → 403
    assert.equal((await api('GET', '/api/admin/logs', undefined, TOKEN)).status, 403)
    assert.equal((await api('GET', '/api/admin/logs')).status, 401)
  })

  test('消息与 meta 超长截断，不整条拒收', async () => {
    const r = await api('POST', '/api/logs', {
      deviceId: DEVICE,
      entries: [entry('warn', 'x'.repeat(5000), { meta: { blob: 'y'.repeat(5000) } })]
    })
    assert.equal(r.json.added, 1)
    const admin = await adminToken()
    const list = await api('GET', '/api/admin/logs', undefined, admin)
    assert.ok(list.json.logs[0].message.length <= 2000)
  })
})
