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

// M11 客户端「套餐与余额」钱包页：概览/套餐/充值/账单四页签逐个点开渲染
test('客户端套餐与余额：四页签均正常渲染（新老板空态）', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-bill-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-billing').click()

  // 概览：三张统计卡（余额/积分/账号配额）+ 未订阅提示
  await expect(win.locator('.stat-card')).toHaveCount(3, { timeout: 10_000 })
  await expect(win.getByText('余额', { exact: true })).toBeVisible()
  await expect(win.getByText('模型积分')).toBeVisible()
  await expect(win.getByText('账号配额')).toBeVisible()
  await expect(win.getByText('还没有订阅套餐。前往「套餐」页签选购。')).toBeVisible()
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-29-billing-overview.png` })

  // 套餐页：说明文案渲染（无套餐时列表空，容器仍在）
  await win.locator('.page-tabs button', { hasText: '套餐' }).click()
  await expect(win.getByText('套餐决定可同时登录的平台账号数量。用余额支付；余额不足请先充值。')).toBeVisible()

  // 充值页渲染（充值标题恒在；不断言“无通道”空态——共享租户里别的用例会建通道）
  await win.locator('.page-tabs button', { hasText: '充值' }).click()
  await expect(win.getByRole('heading', { name: '充值', exact: true })).toBeVisible()

  // 账单页：充值订单表头渲染
  await win.locator('.page-tabs button', { hasText: '账单' }).click()
  await expect(win.getByRole('heading', { name: '充值订单' })).toBeVisible()

  await app.close()
})
