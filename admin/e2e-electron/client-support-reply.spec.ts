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

// M18 支持工单双向：客户端提交 → 后台(经 API 用管理员令牌)回复 → 客户端看到客服回复
test('客户端帮助与反馈：收到客服回复并显示在工单里', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-supreply-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const TAG = Date.now().toString(36).slice(-5)
  const subject = `登录报错${TAG}`
  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 客户端提交工单
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-support').click()
  await win.getByRole('button', { name: '提交问题' }).first().click()
  await win.locator('.form-page input[type="text"]').first().fill(subject)
  await win.locator('textarea').first().fill('打开软件后一直卡在登录页。')
  await win.getByRole('button', { name: '提交', exact: true }).click()
  await expect(win.getByText(subject).first()).toBeVisible({ timeout: 10_000 })

  // 后台经 API 用管理员令牌回复该工单
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const list = await fetch(`${API}/api/admin/support/tickets`, { headers: aAuth })
    .then((r) => r.json() as Promise<{ tickets: Array<{ id: string; title: string }> }>)
  const ticket = list.tickets.find((t) => t.title === subject)
  expect(ticket, '后台应能看到该工单').toBeTruthy()
  const replyRes = await fetch(`${API}/api/support/tickets/${ticket!.id}/messages`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ body: '收到，请尝试重装最新版E2E' })
  })
  expect(replyRes.ok).toBeTruthy()

  // 客户端打开该工单 → 看到客服回复(theirs)
  await win.locator('.ticket-item, li, button', { hasText: subject }).first().click()
  const reply = win.locator('.sup-msg.theirs').filter({ hasText: '收到，请尝试重装最新版E2E' })
  await expect(reply).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-46-support-reply.png` })
  await app.close()
})
