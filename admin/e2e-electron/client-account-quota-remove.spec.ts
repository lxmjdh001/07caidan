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

// M11 账号配额软门·删除方向：撞上限后删掉一个账号腾出名额 → 加号应即时恢复。
// 若删除不让软门复位，撞过上限的老板删了账号也永远加不了新号，是把人锁死的坑。
// 这也是配额修复的关键护栏：软门必须可逆。seed 一个非主账号占满 maxAccounts=2 配额。
test('客户端账号配额：删账号腾出名额后加号即时恢复（删除方向）', async () => {
  const TAG = Date.now().toString(36).slice(-5)
  // 预置 主账号 + 一个 Telegram Bot 账号（启动即注册为 stopped，显示在账号栏、可删）
  const seededKey = `telegram_bot:tb${TAG}`
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    join(USER_DATA, 'settings.json'),
    JSON.stringify({ locale: 'zh-CN', accounts: { 'whatsapp:main': {}, [seededKey]: { label: `待删账号${TAG}` } } }),
    'utf8'
  )

  const planName = `双账号套餐${TAG}`
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  const aAuth = { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }
  const plan = await fetch(`${API}/api/admin/plans`, {
    method: 'POST', headers: aAuth,
    body: JSON.stringify({ name: planName, priceCents: 2000, periodUnit: 'month', periodCount: 1, maxAccounts: 2, maxDevices: 0 })
  }).then((r) => r.json() as Promise<{ plan: { id: string } }>)
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  await fetch(`${API}/api/admin/balance-adjust`, {
    method: 'POST', headers: aAuth, body: JSON.stringify({ email, deltaCents: 5000, note: 'e2e' })
  })
  await fetch(`${API}/api/billing/subscribe`, {
    method: 'POST', headers: { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ planId: plan.plan.id })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-quotarm-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  win.on('dialog', (d) => void d.accept()) // 删除确认框自动接受

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 2 个账号占满配额 2 → 加号禁用 + 提示
  const addBtn = win.locator('.account-list-header .icon-btn')
  await expect(addBtn).toBeDisabled({ timeout: 10_000 })
  await expect(win.locator('.account-quota-hint')).toHaveText('已达账号上限，请升级套餐')

  // 从账号右键菜单删除账号（confirm 自动接受）。
  const row = win.locator('.account-row', { hasText: `待删账号${TAG}` })
  await row.hover()
  await row.locator('.account-row-more').click()
  await win.locator('.account-context-menu').getByRole('button', { name: '删除账号' }).click()
  await expect(row).toHaveCount(0, { timeout: 10_000 })

  // 账号数回落到 1 < 配额 2 → 加号即时恢复、提示消失（软门可逆，不锁死）
  await expect(addBtn).toBeEnabled({ timeout: 10_000 })
  await expect(win.locator('.account-quota-hint')).toHaveCount(0)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-account-quota-remove.png` })
  await app.close()
})
