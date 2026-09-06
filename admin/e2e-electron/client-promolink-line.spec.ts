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

// M10 推广链接 LINE 分支：LINE 取不到官方 ID 需手填 → 生成 line.me 入口链接带 ref 追踪码
test('客户端推广链接 LINE：手填官方 ID 生成带 ref 的入口链接', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  // 预置一个 LINE 账号（假凭证，仅让它出现在推广链接账号选择器里）
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({
    locale: 'zh-CN',
    accounts: {
      'whatsapp:main': {},
      'line:acc1': { label: 'LINE官号E2E', credentials: { channelAccessToken: 'x', channelSecret: 'y', providerId: 'p' } }
    }
  }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-pll-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-management').click()
  await win.getByTestId('management-workorders').click()
  await win.locator('.page-tabs button', { hasText: '推广链接' }).click()

  // 选 LINE 账号
  const accSel = win.locator('label', { hasText: '账号' }).locator('select').first()
  await accSel.selectOption('line:acc1')
  // LINE 专属提示：需手填官方 ID
  await expect(win.getByText(/LINE 取不到官方账号 ID/)).toBeVisible({ timeout: 10_000 })

  // 手填官方 ID + 追踪码
  await win.locator('label', { hasText: '账号联系方式' }).locator('input').fill('myshop')
  await win.locator('label', { hasText: '追踪码' }).locator('input').fill('promo88')

  // 生成的入口链接为 line.me 格式且含 ref 码
  const preview = win.locator('.link-preview code')
  await expect(preview).toBeVisible({ timeout: 10_000 })
  await expect(preview).toContainText('line.me/R/oaMessage')
  await expect(preview).toContainText('promo88')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-44-promolink-line.png` })
  await app.close()
})
