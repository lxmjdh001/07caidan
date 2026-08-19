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

async function loginToken(email: string, password: string): Promise<string | undefined> {
  const r = (await fetch(`${API}/api/client/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  }).then((x) => x.json())) as { token?: string }
  return r.token
}

// M21 团队管理：老板给子账号「改密码」（window.prompt 输入新密码）→ updateTeamMember 落库。
// 无可见 UI 变化，故以登录结果验证：新密码可登录、旧密码失效。既有 team 用例未覆盖改密码。
test('客户端团队：改子账号密码后新密码可登录、旧密码失效', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = `${Date.now().toString(36).slice(-5)}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const OLD = 'agentpass123'
  const NEW = 'newpass45678'

  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' }
  await fetch(`${API}/api/team/members`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ username: `agent${TAG}`, password: OLD, role: 'agent' })
  })
  // 子账号登录名（含 @<数字> 合成域）从服务端取
  const members = (await fetch(`${API}/api/team/members`, { headers: auth }).then((r) => r.json())) as { members?: Array<{ email: string }> }
  const memberEmail = members.members?.[0]?.email
  expect(memberEmail, '应有一个子账号').toBeTruthy()
  // 基线：旧密码可登录
  expect(await loginToken(memberEmail!, OLD)).toBeTruthy()

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-mreset-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '团队管理' }).click()
  const row = win.locator('tr', { hasText: `agent${TAG}` })
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 「改密码」打开应用内弹窗（Electron 不支持 window.prompt，此前该功能是坏的）
  await row.getByRole('button', { name: '改密码' }).click()
  const modal = win.locator('.modal', { hasText: '改密码' })
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await expect(modal.getByText(memberEmail!)).toBeVisible()
  await modal.locator('input[type="password"]').fill(NEW)

  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-86-member-reset-password.png` })

  await modal.getByRole('button', { name: '保存' }).click()
  await expect(modal).toBeHidden({ timeout: 10_000 })

  // 落库以登录结果验证：新密码可登录
  await expect.poll(() => loginToken(memberEmail!, NEW), { timeout: 10_000 }).toBeTruthy()
  // 旧密码此刻失效
  expect(await loginToken(memberEmail!, OLD)).toBeFalsy()

  await app.close()
})
