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

// M11 客户端账单：已支付充值订单在账单页显示（状态已支付、金额正确）
test('客户端账单：已支付订单在账单页显示', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const ch = await fetch(`${API}/api/admin/channels`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ type: 'mock', name: `通道${TAG}`, currency: 'USD' })
  }).then((r) => r.json() as Promise<{ channel: { id: string } }>)

  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const order = await fetch(`${API}/api/billing/orders`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'topup', amountCents: 1500, channelId: ch.channel.id })
  }).then((r) => r.json() as Promise<{ order: { id: string } }>)
  expect(order.order?.id).toBeTruthy()
  // 管理员标记已支付 → 到账
  const paid = await fetch(`${API}/api/admin/orders/${order.order.id}/mark-paid`, { method: 'POST', headers: aAuth })
  expect(paid.ok).toBeTruthy()

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-billhist-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '套餐与余额' }).click()
  await win.locator('.page-tabs button', { hasText: '账单' }).click()

  // 账单表：$15.00 的已支付订单
  const row = win.locator('table tbody tr').filter({ hasText: '$15.00' })
  await expect(row.first()).toBeVisible({ timeout: 10_000 })
  await expect(row.first()).toContainText('已支付')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-51-billing-history.png` })
  await app.close()
})
