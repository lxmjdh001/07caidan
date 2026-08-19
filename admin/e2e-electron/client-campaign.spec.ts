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

test('客户端：新建引流工单全流程（选账号→填名→创建→列表出现）', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-camp-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  // 打开「引流工单」页 → 新建工单
  await win.locator('.rail-nav', { hasText: '引流工单' }).click()
  await win.getByRole('button', { name: '新建工单' }).first().click()

  // 填名称 + 选第一个账号（起始时间默认今天）
  await win.locator('input[placeholder="如：八月东南亚推广"]').fill('E2E 测试工单')
  await win.locator('.check-grid .check-item').first().locator('input[type="checkbox"]').check()

  // 提交（表单底部的「新建工单」按钮）
  await win.getByRole('button', { name: '新建工单' }).last().click()

  // 回到列表，工单出现
  await expect(win.getByText('E2E 测试工单')).toBeVisible({ timeout: 10_000 })
  await win.waitForTimeout(500)
  await win.screenshot({ path: `${SHOT_DIR}/client-18-campaign-created.png` })
  await app.close()
})
