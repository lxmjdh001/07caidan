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

async function devicesStatus(token: string): Promise<number> {
  return (await fetch(`${API}/api/client/devices`, { headers: { authorization: `Bearer ${token}` } })).status
}

// 红线（会话安全）：老板给子账号改密码必须让其旧令牌立即失效（凭证泄露后改密可踢走攻击者会话）。
// member-reset-password 验了新/旧密码在登录处的结果；改密对已持有的旧令牌的吊销此前没测。
test('客户端子账号改密码：旧令牌立即失效', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const agent = `agent${TAG}`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const member = await fetch(`${API}/api/team/members`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username: agent, password: 'agentpass123', role: 'agent' })
  }).then((r) => r.json() as Promise<{ member: { email: string } }>)
  const memberEmail = member.member.email
  const oldToken = (await fetch(`${API}/api/client/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: memberEmail, password: 'agentpass123' })
  }).then((r) => r.json()) as { token?: string }).token
  expect(oldToken).toBeTruthy()
  // 改密前：旧令牌可用
  expect(await devicesStatus(oldToken!)).toBe(200)

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-pwdkill-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-management').click()
  await win.getByTestId('management-subaccounts').click()
  const row = win.locator('tr', { hasText: agent })
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.getByRole('button', { name: '改密码' }).click()
  const modal = win.locator('.modal', { hasText: '改密码' })
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await modal.locator('input[type="password"]').fill('newpass98765')
  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-104-passwd-change-kills-token.png` })
  await modal.getByRole('button', { name: '保存' }).click()
  await expect(modal).toBeHidden({ timeout: 10_000 })

  // 红线：改密后旧令牌立即失效（不再 200）
  await expect.poll(() => devicesStatus(oldToken!), { timeout: 10_000 }).not.toBe(200)

  await app.close()
})
