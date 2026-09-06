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

// M11 客户端充值：客户承担手续费的通道卡展示 gross-up 应付（ceil((amount+fixed)/(1-rate))）
// 并能生成付款单。此前 client-billing 只点开充值页看标题，客户端侧手续费口径与下单从未覆盖。
test('客户端充值：客户承担手续费通道显示 gross-up 应付并生成付款单', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const chName = `手续费通道${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`

  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  // 客户承担 5% 手续费的 mock 通道：$10 → 应付 ceil(1000/0.95)=1053=$10.53，手续费 $0.53
  await fetch(`${API}/api/admin/channels`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ type: 'mock', name: chName, currency: 'USD', feeRate: 0.05, feeFixedCents: 0, feePaidBy: 'customer' })
  })
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-topup-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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
  await win.getByTestId('client-nav-billing').click()
  await win.locator('.page-tabs button', { hasText: '充值' }).click()

  // 金额 $10.00（默认）→ 我的通道卡展示手续费 $0.53、应付 $10.53
  await win.locator('label.field', { hasText: '金额（美元）' }).locator('input').fill('10.00')
  const card = win.locator('.channel-card', { hasText: chName })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card.locator('.channel-payable')).toHaveText('应付 $10.53')
  await expect(card.locator('.channel-fee')).toHaveText('手续费 $0.53')

  // 选中该通道 → 出现整体应付预估提示（手续费约 $0.53，预计支付 $10.53）
  await card.click()
  await expect(win.getByText(/手续费约 \$0\.53.*预计支付 \$10\.53/)).toBeVisible({ timeout: 10_000 })

  // 生成付款单 → mock 通道返回 payload（含币种 USD 与开发通道提示）
  await win.getByRole('button', { name: '生成付款单' }).click()
  const payload = win.locator('.pay-payload')
  await expect(payload).toBeVisible({ timeout: 10_000 })
  await expect(payload).toContainText('USD')
  await expect(payload).toContainText('开发通道')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-82-topup-grossup.png` })
  await app.close()
})
