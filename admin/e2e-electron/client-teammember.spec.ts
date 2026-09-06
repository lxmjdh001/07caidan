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

test('客户端团队：老板建客服子账号，子账号可登录', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-team-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  // 有启用的全员公告时会弹通知框，其 backdrop 会拦截后续点击，先关掉
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-management').click()
  await win.getByTestId('management-subaccounts').click()
  await win.getByRole('button', { name: '新建子账号' }).click()

  const modal = win.locator('.modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await modal.locator('input').first().fill('agent01')
  await modal.locator('input[type="password"]').fill('agentpass123')
  await modal.locator('.modal-footer button').last().click()

  // 成员表出现子账号（登录名 agent01@<老板id>）
  const cell = win.locator('.team-login-cell').filter({ hasText: 'agent01@' }).first()
  await expect(cell).toBeVisible({ timeout: 10_000 })
  const loginName = ((await cell.textContent()) ?? '').trim()
  const account = /agent01@\d+/.exec(loginName)?.[0]
  expect(account, `未解析出登录名，得到 ${loginName}`).toBeTruthy()

  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-22-teammember.png` })

  // 该子账号确实可登录后台
  const res = (await fetch(`${API}/api/client/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account, password: 'agentpass123' })
  }).then((r) => r.json())) as { token?: string; user?: { role?: string } }
  expect(res.token, '子账号应能登录并拿到令牌').toBeTruthy()
  expect(res.user?.role).toBe('agent')

  await app.close()
})
