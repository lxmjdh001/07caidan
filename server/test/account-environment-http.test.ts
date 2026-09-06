import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import BetterSqlite3 from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const STATIC_TOKEN = 'dev-token'
const DEVICE_A = 'a'.repeat(32)
const DEVICE_B = 'b'.repeat(32)
const ACCOUNT_KEY = 'telegram:account1'
let dir: string
let dbPath: string
let app: FastifyInstance

function makeConfig(path: string): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath: path,
    mediaDir: join(dir, 'media'),
    tokens: [STATIC_TOKEN],
    anthropicApiKey: undefined,
    analysisModel: 'claude-opus-5',
    adminUser: 'admin',
    adminPassword: 'admin',
    adminTenant: STATIC_TOKEN,
    requireEmailVerify: false,
    clientTenant: STATIC_TOKEN,
    smtp: undefined,
    publicUrl: 'http://localhost:8787',
    updatesDir: join(dir, 'updates'),
    crispWebsiteId: undefined,
    accountEnvironmentEncryptionKey: 'test-account-environment-key-at-least-32-characters'
  }
}

async function request(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  token?: string,
  payload?: object
) {
  const response = await app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload ? { payload } : {})
  })
  return { status: response.statusCode, body: response.json() as Record<string, any> }
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'wzzscrm-environment-')) })
after(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  await app?.close()
  dbPath = join(dir, `${Math.random().toString(36).slice(2)}.db`)
  app = buildServer(makeConfig(dbPath))
  await app.ready()
})

describe('跨设备账号环境', () => {
  test('快照加密落库、同工作区可恢复，并由新电脑安全接管租约', async () => {
    const registered = await request('POST', '/api/client/register', undefined, {
      email: 'owner@example.com', password: 'password123', deviceId: DEVICE_A, deviceName: 'Mac'
    })
    assert.equal(registered.status, 200)
    const tokenA = registered.body.token as string

    const acquiredA = await request(
      'POST', `/api/client/environments/${ACCOUNT_KEY}/lease`, tokenA,
      { deviceId: DEVICE_A, takeover: true }
    )
    assert.equal(acquiredA.status, 200)
    const leaseA = acquiredA.body.leaseId as string

    const secretSession = 'telegram-session-secret-value'
    const saved = await request('PUT', `/api/client/environments/${ACCOUNT_KEY}`, tokenA, {
      deviceId: DEVICE_A,
      leaseId: leaseA,
      snapshot: {
        version: 1,
        account: {
          label: '客服主号',
          credentials: { session: secretSession },
          fingerprint: { id: 'FP-ABC', seed: 'fingerprint-secret' },
          proxyUrl: 'socks5://user:password@127.0.0.1:1080'
        },
        files: []
      }
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.environment.revision, 1)

    const loginB = await request('POST', '/api/client/login', undefined, {
      email: 'owner@example.com', password: 'password123', deviceId: DEVICE_B, deviceName: 'Windows'
    })
    assert.equal(loginB.status, 200)
    const tokenB = loginB.body.token as string

    const refused = await request(
      'POST', `/api/client/environments/${ACCOUNT_KEY}/lease`, tokenB,
      { deviceId: DEVICE_B, takeover: false }
    )
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'environment_in_use')

    const takeover = await request(
      'POST', `/api/client/environments/${ACCOUNT_KEY}/lease`, tokenB,
      { deviceId: DEVICE_B, takeover: true }
    )
    assert.equal(takeover.status, 200)
    const leaseB = takeover.body.leaseId as string
    assert.equal(takeover.body.environment.snapshot.account.credentials.session, secretSession)

    const oldHeartbeat = await request(
      'POST', `/api/client/environments/${ACCOUNT_KEY}/heartbeat`, tokenA,
      { deviceId: DEVICE_A, leaseId: leaseA }
    )
    assert.equal(oldHeartbeat.status, 409)
    const staleRelease = await request(
      'POST', `/api/client/environments/${ACCOUNT_KEY}/release`, tokenA,
      { deviceId: DEVICE_A, leaseId: leaseA }
    )
    assert.equal(staleRelease.status, 200)
    assert.equal(staleRelease.body.ok, false)
    const newHeartbeat = await request(
      'POST', `/api/client/environments/${ACCOUNT_KEY}/heartbeat`, tokenB,
      { deviceId: DEVICE_B, leaseId: leaseB }
    )
    assert.equal(newHeartbeat.status, 200)

    const sqlite = new BetterSqlite3(dbPath, { readonly: true })
    const row = sqlite.prepare('SELECT snapshot FROM account_environments').get() as { snapshot: string }
    sqlite.close()
    assert.match(row.snapshot, /^v1:/)
    assert.equal(row.snapshot.includes(secretSession), false)
    assert.equal(row.snapshot.includes('fingerprint-secret'), false)
    assert.equal(row.snapshot.includes('password@'), false)
  })

  test('不同客户工作区完全隔离，静态同步令牌不能读取环境密文', async () => {
    const owner = await request('POST', '/api/client/register', undefined, {
      email: 'first@example.com', password: 'password123', deviceId: DEVICE_A
    })
    const ownerToken = owner.body.token as string
    const ownerLease = await request(
      'POST', `/api/client/environments/${ACCOUNT_KEY}/lease`, ownerToken,
      { deviceId: DEVICE_A, takeover: true }
    )
    assert.equal((await request('PUT', `/api/client/environments/${ACCOUNT_KEY}`, ownerToken, {
      deviceId: DEVICE_A,
      leaseId: ownerLease.body.leaseId,
      snapshot: { version: 1, account: { credentials: { session: 'first-secret' } }, files: [] }
    })).status, 200)

    const other = await request('POST', '/api/client/register', undefined, {
      email: 'second@example.com', password: 'password123', deviceId: DEVICE_B
    })
    const otherLease = await request(
      'POST', `/api/client/environments/${ACCOUNT_KEY}/lease`, other.body.token as string,
      { deviceId: DEVICE_B, takeover: false }
    )
    assert.equal(otherLease.status, 200)
    assert.equal(otherLease.body.environment, undefined)

    const staticTokenAccess = await request(
      'POST', `/api/client/environments/${ACCOUNT_KEY}/lease`, STATIC_TOKEN,
      { deviceId: DEVICE_B, takeover: false }
    )
    assert.equal(staticTokenAccess.status, 403)
  })
})
