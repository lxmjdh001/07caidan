import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const ELECTRON_PATH = createRequire(join(CLIENT_DIR, 'package.json'))('electron') as string
const USER_DATA = mkdtempSync(join(tmpdir(), 'omni-e2e-'))
const API = 'http://127.0.0.1:8798'

async function login(email: string, password: string): Promise<string | undefined> {
  const r = (await fetch(`${API}/api/client/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  }).then((x) => x.json())) as { token?: string }
  return r.token
}
async function postStatus(token: string, path: string, body: unknown): Promise<number> {
  return (await fetch(`${API}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })).status
}

// 红线（纵深防御）：客服(agent)不仅前端导航被隐藏，服务端也必须 403 拦下越权 API。
// agent-rbac 只验前端隐藏；服务端 requireClientPerm 强制此前无 e2e。若服务端不拦，
// 隐藏 UI 只是障眼法——agent 直接打 API 就能越权建工单/发链接/建子账号。
test('客户端 RBAC 纵深防御：客服直接调越权 API 被服务端 403', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const member = await fetch(`${API}/api/team/members`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username: `agent${TAG}`, password: 'agentpass123', role: 'agent' })
  }).then((r) => r.json() as Promise<{ member: { email: string } }>)
  const agentEmail = member.member.email

  // 以客服登录客户端，截图受限界面（前端隐藏由 agent-rbac 详测，此处取证）
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-authz-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.locator('input[type="email"]').fill(agentEmail)
  await win.locator('input[type="password"]').fill('agentpass123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()
  await expect(win.locator('.rail-nav', { hasText: '引流工单' })).toHaveCount(0)
  await win.screenshot({ path: `${SHOT_DIR}/client-100-agent-server-authz.png` })
  await app.close()

  // 服务端纵深防御：老板可建工单(有 campaigns:manage)，客服直接打 API 被 403
  const agentToken = await login(agentEmail, 'agentpass123')
  expect(agentToken, '客服应能登录拿到令牌').toBeTruthy()

  const campBody = { name: `越权工单${TAG}`, accountIds: ['main'], accountLabels: { main: '主号' }, startAt: Date.now() }
  // 老板：允许
  expect([200, 201]).toContain(await postStatus(reg.token, '/api/campaigns', campBody))
  // 客服（无 campaigns:manage）：建工单 / 发推广链接 均 403
  expect(await postStatus(agentToken!, '/api/campaigns', campBody)).toBe(403)
  expect(await postStatus(agentToken!, '/api/entry-links', { channel: 'whatsapp', accountId: 'main', handle: '8613800138000', code: 'x1' })).toBe(403)
  // 客服（无 team:manage）：建子账号 403
  expect(await postStatus(agentToken!, '/api/team/members', { username: `sub${TAG}`, password: 'secret12345', role: 'agent' })).toBe(403)
})
