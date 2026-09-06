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

// M12 兑换积分余额不足护栏：兑换额 > 余额 → 服务端 400「余额不足」→ 客户端提示、
// 余额与积分不变。client-exchange-credits 只覆盖成功路径，余额不足这条错误护栏没测。
test('客户端钱包：兑换积分超出余额时提示余额不足且不扣款', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  })
  const admin = await fetch(`${API}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  }).then((r) => r.json() as Promise<{ token: string }>)
  // 只给 $1 余额
  await fetch(`${API}/api/admin/balance-adjust`, {
    method: 'POST', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, deltaCents: 100, note: 'e2e' })
  })

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-exins-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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
  const balance = win.locator('.stat-card').filter({ hasText: '余额' }).locator('.v')
  const credits = win.locator('.stat-card').filter({ hasText: '模型积分' }).locator('.v')
  await expect(balance).toHaveText('$1.00', { timeout: 10_000 })
  await expect(credits).toHaveText('0')

  // 兑换 $5（超过 $1 余额）→ 余额不足提示，且余额/积分不变
  await win.locator('label.field', { hasText: '金额（美元）' }).locator('input').fill('5.00')
  await win.getByRole('button', { name: '兑换', exact: true }).click()

  await expect(win.getByText(/余额不足/).first()).toBeVisible({ timeout: 10_000 })
  await expect(balance).toHaveText('$1.00')
  await expect(credits).toHaveText('0')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-96-exchange-insufficient.png` })
  await app.close()
})
