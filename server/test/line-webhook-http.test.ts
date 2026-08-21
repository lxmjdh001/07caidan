import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

// /webhook/line/:tenant/:accountId 是公开回调，唯一的门就是 HMAC 签名。line-relay 单测只覆盖
// verifySignature 纯函数；这条路由的接线(有没有真调、验签用的是不是原始字节、验不过会不会
// 照样入队)此前零覆盖。验签一旦形同虚设，任何人都能往租户会话里注入伪造 LINE 消息。
const TOKEN = 'dev-token'
const SECRET = 'line-channel-secret-abc123'
const ACCT = 'lineacct1'

describe('LINE Webhook 签名验证（HTTP）', () => {
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

  const sign = (raw: string): string => createHmac('sha256', SECRET).update(raw).digest('base64')
  const webhook = (raw: string, sig: string) =>
    app.inject({
      method: 'POST',
      url: `/webhook/line/${TOKEN}/${ACCT}`,
      headers: { 'content-type': 'application/json', 'x-line-signature': sig },
      payload: raw
    })
  const pulledRaw = async (): Promise<string> => {
    const r = await app.inject({ method: 'GET', url: '/api/line/pull-all', headers: { authorization: `Bearer ${TOKEN}` } })
    return JSON.stringify(r.json())
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-lwh-'))
  })
  after(async () => {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await app?.close()
    app = buildServer(makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
    await app.ready()
    await app.inject({
      method: 'POST',
      url: '/api/line/register',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { accountId: ACCT, channelSecret: SECRET }
    })
  })

  test('正确签名 → 200 且事件入队、可被客户端拉取', async () => {
    const raw = JSON.stringify({ events: [{ type: 'message', id: 'legit-evt' }] })
    const r = await webhook(raw, sign(raw))
    assert.equal(r.statusCode, 200)
    assert.ok((await pulledRaw()).includes('legit-evt'), '合法事件应已入队')
  })

  test('错误签名 → 401 且事件绝不入队（防伪造注入）', async () => {
    const raw = JSON.stringify({ events: [{ type: 'message', id: 'FORGED' }] })
    const r = await webhook(raw, 'AAAAtotallyBogusSignature==')
    assert.equal(r.statusCode, 401)
    assert.equal((await pulledRaw()).includes('FORGED'), false, '验签失败的事件不得入队')
  })

  test('缺签名头 → 401', async () => {
    const raw = JSON.stringify({ events: [{ id: 'nosig' }] })
    const r = await app.inject({
      method: 'POST',
      url: `/webhook/line/${TOKEN}/${ACCT}`,
      headers: { 'content-type': 'application/json' },
      payload: raw
    })
    assert.equal(r.statusCode, 401)
    assert.equal((await pulledRaw()).includes('nosig'), false)
  })

  test('篡改正文（签名是对原文签的、正文被改）→ 401 且不入队', async () => {
    // 攻击者截获一条合法签名，替换正文注入自己的事件 —— 验签必须基于原始字节，签名对不上改后正文
    const original = JSON.stringify({ events: [{ id: 'original' }] })
    const validSigForOriginal = sign(original)
    const tampered = JSON.stringify({ events: [{ id: 'TAMPERED-INJECT' }] })
    const r = await webhook(tampered, validSigForOriginal)
    assert.equal(r.statusCode, 401, '改后正文与原签名对不上，必须拒')
    assert.equal((await pulledRaw()).includes('TAMPERED-INJECT'), false)
  })

  test('未注册账号 → 404（不泄露是否存在的差异可后续再收敛）', async () => {
    const raw = JSON.stringify({ events: [] })
    const r = await app.inject({
      method: 'POST',
      url: `/webhook/line/${TOKEN}/ghost-account`,
      headers: { 'content-type': 'application/json', 'x-line-signature': sign(raw) },
      payload: raw
    })
    assert.equal(r.statusCode, 404)
  })

  test('换个 channelSecret 签的名 → 401（不是随便谁签都认）', async () => {
    const raw = JSON.stringify({ events: [{ id: 'wrongsecret' }] })
    const sigByAttacker = createHmac('sha256', 'attacker-guessed-secret').update(raw).digest('base64')
    const r = await webhook(raw, sigByAttacker)
    assert.equal(r.statusCode, 401)
    assert.equal((await pulledRaw()).includes('wrongsecret'), false)
  })
})
