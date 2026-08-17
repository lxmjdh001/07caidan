import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { ServerConfig } from '../src/config.ts'
import { buildServer } from '../src/server.ts'

const TOKEN = 'dev-token'

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

/** 注册一个老板并返回令牌 */
async function registerBoss(email = 'boss@test.com'): Promise<string> {
  const r = await api('POST', '/api/client/register', { email, password: 'bosspass123' })
  assert.equal(r.status, 200)
  return r.json.token
}

/** 子账号完整登录名：<用户名>@<老板id> */
async function loginNameOf(bossToken: string, username: string): Promise<string> {
  const me = await api('GET', '/api/me/permissions', undefined, bossToken)
  return `${username}@${me.json.userId}`
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-team-'))
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

describe('客户端 RBAC：老板与子账号', () => {
  test('自助注册即老板：返回 boss 角色和全量权限', async () => {
    const r = await api('POST', '/api/client/register', {
      email: 'boss@test.com',
      password: 'bosspass123'
    })
    assert.equal(r.json.user.role, 'boss')
    assert.ok(r.json.user.permissions.includes('team:manage'))
    assert.ok(r.json.user.permissions.includes('billing:manage'))
  })

  test('老板建客服子账号，客服登录后是空权限', async () => {
    const boss = await registerBoss()
    const created = await api(
      'POST',
      '/api/team/members',
      { username: 'agent1', password: 'agentpass123', role: 'agent' },
      boss
    )
    assert.equal(created.status, 200)
    assert.equal(created.json.member.role, 'agent')

    const login = await api('POST', '/api/client/login', {
      email: await loginNameOf(boss, 'agent1'),
      password: 'agentpass123'
    })
    assert.equal(login.status, 200)
    assert.equal(login.json.user.role, 'agent')
    assert.deepEqual(login.json.user.permissions, [])
  })

  test('服务端强制：客服访问工单/账单/团队接口都是 403', async () => {
    const boss = await registerBoss()
    await api(
      'POST',
      '/api/team/members',
      { username: 'agent1', password: 'agentpass123', role: 'agent' },
      boss
    )
    const agent = (
      await api('POST', '/api/client/login', {
        email: await loginNameOf(boss, 'agent1'),
        password: 'agentpass123'
      })
    ).json.token

    assert.equal((await api('GET', '/api/campaigns', undefined, agent)).status, 403)
    assert.equal((await api('GET', '/api/fan-libraries', undefined, agent)).status, 403)
    assert.equal((await api('GET', '/api/billing/me', undefined, agent)).status, 403)
    assert.equal((await api('GET', '/api/billing/ledger', undefined, agent)).status, 403)
    assert.equal((await api('GET', '/api/team/members', undefined, agent)).status, 403)
    // 但聊天基础能力不受限：通知、支持工单照常
    assert.equal((await api('GET', '/api/notices', undefined, agent)).status, 200)
    assert.equal((await api('GET', '/api/support/tickets', undefined, agent)).status, 200)
  })

  test('老板照常访问工单与账单', async () => {
    const boss = await registerBoss()
    assert.equal((await api('GET', '/api/campaigns', undefined, boss)).status, 200)
    assert.equal((await api('GET', '/api/billing/me', undefined, boss)).status, 200)
  })

  test('自定义角色：子集权限生效，超集被拒', async () => {
    const boss = await registerBoss()
    const role = await api(
      'POST',
      '/api/team/roles',
      { name: '运营主管', permissions: ['campaigns:manage', 'settings:manage'] },
      boss
    )
    assert.equal(role.status, 200)
    const roleId = role.json.role.id

    await api(
      'POST',
      '/api/team/members',
      { username: 'lead', password: 'leadpass123', role: roleId },
      boss
    )
    const lead = (
      await api('POST', '/api/client/login', {
        email: await loginNameOf(boss, 'lead'),
        password: 'leadpass123'
      })
    ).json
    assert.deepEqual([...lead.user.permissions].sort(), ['campaigns:manage', 'settings:manage'])

    // 有 campaigns:manage → 能访问工单；没有 billing:manage → 账单仍被拒
    assert.equal((await api('GET', '/api/campaigns', undefined, lead.token)).status, 200)
    assert.equal((await api('GET', '/api/billing/me', undefined, lead.token)).status, 403)
  })

  test('委派收敛：有 team:manage 的主管不能分配超出自己权限的角色', async () => {
    const boss = await registerBoss()
    // 主管角色：只有 team:manage + campaigns:manage
    const roleId = (
      await api(
        'POST',
        '/api/team/roles',
        { name: '主管', permissions: ['team:manage', 'campaigns:manage'] },
        boss
      )
    ).json.role.id
    // 老板同时建一个包含 billing:manage 的角色
    const richRoleId = (
      await api('POST', '/api/team/roles', { name: '财务', permissions: ['billing:manage'] }, boss)
    ).json.role.id

    await api(
      'POST',
      '/api/team/members',
      { username: 'lead', password: 'leadpass123', role: roleId },
      boss
    )
    const lead = (
      await api('POST', '/api/client/login', {
        email: await loginNameOf(boss, 'lead'),
        password: 'leadpass123'
      })
    ).json.token

    // 主管给自己团队建号：分配纯聊天客服可以
    const okCreate = await api(
      'POST',
      '/api/team/members',
      { username: 'a2', password: 'agentpass123', role: 'agent' },
      lead
    )
    assert.equal(okCreate.status, 200)
    // 分配含 billing:manage 的角色必须被拒（超出主管自己的权限）
    const bad = await api(
      'POST',
      '/api/team/members',
      { username: 'a3', password: 'agentpass123', role: richRoleId },
      lead
    )
    assert.equal(bad.status, 400)
  })

  test('不允许创建同级 boss 子账号', async () => {
    const boss = await registerBoss()
    const r = await api(
      'POST',
      '/api/team/members',
      { username: 'b2', password: 'bosspass123', role: 'boss' },
      boss
    )
    assert.equal(r.status, 400)
  })

  test('停用子账号：会话立即失效且不能再登录', async () => {
    const boss = await registerBoss()
    const memberId = (
      await api(
        'POST',
        '/api/team/members',
        { username: 'agent1', password: 'agentpass123', role: 'agent' },
        boss
      )
    ).json.member.id
    const agent = (
      await api('POST', '/api/client/login', {
        email: await loginNameOf(boss, 'agent1'),
        password: 'agentpass123'
      })
    ).json.token
    assert.equal((await api('GET', '/api/notices', undefined, agent)).status, 200)

    await api('PATCH', `/api/team/members/${memberId}`, { enabled: false }, boss)
    assert.equal((await api('GET', '/api/notices', undefined, agent)).status, 401, '停用后旧会话必须失效')
    const relogin = await api('POST', '/api/client/login', {
      email: await loginNameOf(boss, 'agent1'),
      password: 'agentpass123'
    })
    assert.equal(relogin.status, 401, '停用后不能登录')
  })

  test('改子账号密码后其会话被吊销', async () => {
    const boss = await registerBoss()
    const memberId = (
      await api(
        'POST',
        '/api/team/members',
        { username: 'agent1', password: 'agentpass123', role: 'agent' },
        boss
      )
    ).json.member.id
    const agent = (
      await api('POST', '/api/client/login', {
        email: await loginNameOf(boss, 'agent1'),
        password: 'agentpass123'
      })
    ).json.token
    await api('PATCH', `/api/team/members/${memberId}`, { password: 'newagentpass1' }, boss)
    assert.equal((await api('GET', '/api/notices', undefined, agent)).status, 401)
    assert.equal(
      (
        await api('POST', '/api/client/login', {
          email: await loginNameOf(boss, 'agent1'),
          password: 'newagentpass1'
        })
      ).status,
      200
    )
  })

  test('有子账号在用的角色不能删除', async () => {
    const boss = await registerBoss()
    const roleId = (
      await api('POST', '/api/team/roles', { name: 'x', permissions: ['campaigns:manage'] }, boss)
    ).json.role.id
    await api(
      'POST',
      '/api/team/members',
      { username: 'a1', password: 'agentpass123', role: roleId },
      boss
    )
    assert.equal((await api('DELETE', `/api/team/roles/${roleId}`, undefined, boss)).status, 400)
  })

  test('列表只看到自己名下的成员和角色', async () => {
    const boss1 = await registerBoss('b1@test.com')
    const boss2 = await registerBoss('b2@test.com')
    await api(
      'POST',
      '/api/team/members',
      { username: 'a1', password: 'agentpass123', role: 'agent' },
      boss1
    )
    await api('POST', '/api/team/roles', { name: 'r1', permissions: [] }, boss1)

    const m2 = await api('GET', '/api/team/members', undefined, boss2)
    assert.equal(m2.json.members.length, 0)
    const r2 = await api('GET', '/api/team/roles', undefined, boss2)
    assert.equal(r2.json.roles.length, 0)
    const m1 = await api('GET', '/api/team/members', undefined, boss1)
    assert.equal(m1.json.members.length, 1)
    assert.match(m1.json.members[0].email, /^a1@\d+$/)
  })

  test('静态同步令牌（自托管开发场景）不受客户端 RBAC 限制', async () => {
    assert.equal((await api('GET', '/api/campaigns', undefined, TOKEN)).status, 200)
  })
})

describe('开启邮箱验证的注册（开发模式固定码 12345）', () => {
  test('无码被拒；固定码 12345 成功；错码被拒', async () => {
    await app.close()
    app = buildServer({
      ...makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)),
      requireEmailVerify: true
    })
    await app.ready()

    const noCode = await api('POST', '/api/client/register', {
      email: 'v@test.com',
      password: 'password123'
    })
    assert.equal(noCode.status, 400)

    // 请求发码（开发模式：未配 SMTP，码固定 12345，不真发邮件）
    assert.equal(
      (await api('POST', '/api/client/send-code', { email: 'v@test.com' })).status,
      200
    )
    const wrong = await api('POST', '/api/client/register', {
      email: 'v@test.com',
      password: 'password123',
      code: '99999'
    })
    assert.equal(wrong.status, 400)

    const ok = await api('POST', '/api/client/register', {
      email: 'v@test.com',
      password: 'password123',
      code: '12345'
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.user.verified, true)
    assert.equal(ok.json.user.role, 'boss')
  })

  test('找回密码同样走固定码', async () => {
    await app.close()
    app = buildServer({
      ...makeConfig(join(dir, `${Math.random().toString(36).slice(2)}.db`)),
      requireEmailVerify: true
    })
    await app.ready()
    await api('POST', '/api/client/send-code', { email: 'v@test.com' })
    await api('POST', '/api/client/register', {
      email: 'v@test.com',
      password: 'password123',
      code: '12345'
    })
    await api('POST', '/api/client/forgot-password', { email: 'v@test.com' })
    const r = await api('POST', '/api/client/reset-password', {
      email: 'v@test.com',
      code: '12345',
      password: 'newpassword1'
    })
    assert.equal(r.status, 200)
    assert.equal(
      (await api('POST', '/api/client/login', { email: 'v@test.com', password: 'newpassword1' }))
        .status,
      200
    )
  })
})

describe('计费主体归属老板', () => {
  test('/api/notices 的套餐定向按老板的订阅算（子账号无自己的订阅）', async () => {
    // 结构性验证：客服能拉通知且不报错 —— 订阅查询走 billingUserId
    const boss = await registerBoss()
    await api(
      'POST',
      '/api/team/members',
      { username: 'agent1', password: 'agentpass123', role: 'agent' },
      boss
    )
    const agent = (
      await api('POST', '/api/client/login', {
        email: await loginNameOf(boss, 'agent1'),
        password: 'agentpass123'
      })
    ).json.token
    const r = await api('GET', '/api/notices', undefined, agent)
    assert.equal(r.status, 200)
    assert.ok(Array.isArray(r.json.announcements))
  })
})
