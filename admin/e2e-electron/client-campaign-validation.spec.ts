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

// M9 新建工单表单校验：无名称/未选账号时提交被拦下并给出对应提示。
// client-campaign 只覆盖成功建单，这些必填校验护栏此前没测。
test('客户端引流工单：新建工单必填校验（名称/账号）', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-cval-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.getByTitle('添加 WhatsApp 账号').click()
  await win.locator('.picker-item', { hasText: 'WhatsApp' }).click()
  await expect(win.locator('.account-platform-group', { hasText: 'WhatsApp' })).toBeVisible()

  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-management').click()
  await win.getByTestId('management-workorders').click()
  await win.getByRole('button', { name: '新建工单' }).first().click()

  const submit = win.getByRole('button', { name: '新建工单' }).last()

  // 空表单提交 → 先拦名称
  await submit.click()
  await expect(win.getByText('请填写工单名称')).toBeVisible({ timeout: 10_000 })

  // 填名称但不选账号 → 拦账号
  await win.locator('input[placeholder="如：八月东南亚推广"]').fill('校验工单E2E')
  await submit.click()
  await expect(win.getByText('请至少选择一个账号')).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-97-campaign-validation.png` })

  // 选上账号后校验通过 → 该错误消失、工单建成进入列表
  await win.locator('.check-grid .check-item').first().locator('input[type="checkbox"]').check()
  await submit.click()
  await expect(win.getByText('请至少选择一个账号')).toHaveCount(0, { timeout: 10_000 })
  await expect(win.getByText('校验工单E2E').first()).toBeVisible({ timeout: 10_000 })

  await app.close()
})
