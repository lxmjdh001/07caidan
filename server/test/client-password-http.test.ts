import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const TENANT = 'dev-token'
let dir: string
let app: FastifyInstance

function makeConfig(dbPath: string): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dbPath,
    mediaDir: join(dir, 'media'),
    tokens: [TENANT],
    anthropicApiKey: undefined,
    analysisModel: 'claude-opus-5',
    adminUser: 'admin',
    adminPassword: 'admin',
    adminTenant: TENANT,
    requireEmailVerify: false,
    clientTenant: TENANT,
    smtp: undefined,
    publicUrl: 'http://localhost:8787',
    updatesDir: join(dir, 'updates'),
    crispWebsiteId: undefined
  }
}

async function call(method: 'GET' | 'POST' | 'PUT', url: string, token?: string, body?: unknown) {
  const response = await app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as object })
  })
  let json: Record<string, any> = {}
  try { json = response.json() } catch { json = {} }
  return { status: response.statusCode, json }
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-password-http-')) })
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })
beforeEach(async () => {
  await app?.close()
  app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
  await app.ready()
})

describe('客户端登录态修改密码（HTTP）', () => {
  test('保留当前令牌、吊销其他令牌并切换到新密码', async () => {
    const registered = await call('POST', '/api/client/register', undefined, {
      email: 'owner@test.com', password: 'oldpass123'
    })
    const currentToken = registered.json.token as string
    const other = await call('POST', '/api/client/login', undefined, {
      email: 'owner@test.com', password: 'oldpass123'
    })
    const otherToken = other.json.token as string

    const changed = await call('PUT', '/api/client/password', currentToken, {
      currentPassword: 'oldpass123', newPassword: 'newpass456'
    })
    assert.equal(changed.status, 200)
    assert.equal((await call('GET', '/api/client/devices', currentToken)).status, 200)
    assert.equal((await call('GET', '/api/client/devices', otherToken)).status, 401)
    assert.equal((await call('POST', '/api/client/login', undefined, {
      email: 'owner@test.com', password: 'oldpass123'
    })).status, 401)
    assert.equal((await call('POST', '/api/client/login', undefined, {
      email: 'owner@test.com', password: 'newpass456'
    })).status, 200)
  })

  test('未登录、当前密码错误和弱密码均被拒绝', async () => {
    assert.equal((await call('PUT', '/api/client/password', undefined, {
      currentPassword: 'oldpass123', newPassword: 'newpass456'
    })).status, 401)
    const registered = await call('POST', '/api/client/register', undefined, {
      email: 'owner@test.com', password: 'oldpass123'
    })
    const token = registered.json.token as string
    assert.equal((await call('PUT', '/api/client/password', token, {
      currentPassword: 'wrong', newPassword: 'newpass456'
    })).status, 400)
    assert.equal((await call('PUT', '/api/client/password', token, {
      currentPassword: 'oldpass123', newPassword: 'short'
    })).status, 400)
  })
})
