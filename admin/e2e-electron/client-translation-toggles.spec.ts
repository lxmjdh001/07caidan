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

// 翻译设置的开关与「我的本地语言」持久化：translation-settings 只覆盖了引擎下拉，
// 入站自动翻译 / 发送前预览确认 两个开关与 displayLang 选择此前没测。
test('客户端翻译设置：入站/预览确认开关与本地语言跨导航持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-trtog-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '设置' }).click()
  await win.locator('.page-tabs button', { hasText: '聊天翻译' }).click()

  const inbound = win.locator('label.field.checkbox', { hasText: '自动翻译收到的消息' }).locator('input')
  const confirm = win.locator('label.field.checkbox', { hasText: '发送前预览译文确认' }).locator('input')
  const displayLang = win.locator('label.field', { hasText: '我的本地语言' }).locator('select')

  // 各自翻到当前的相反态，验证「改动」能落库（不预设默认值）
  const inbTarget = !(await inbound.isChecked())
  const cfmTarget = !(await confirm.isChecked())
  await inbound.setChecked(inbTarget)
  await confirm.setChecked(cfmTarget)
  await displayLang.selectOption({ index: 2 })
  const chosenLang = await displayLang.inputValue()
  expect(chosenLang).not.toBe('')

  await win.getByRole('button', { name: '保存' }).click()
  await expect(win.locator('.save-ok')).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-88-translation-toggles.png` })

  // 离开到别的页面再回设置（整页重挂载，回显来自落库）
  await win.locator('.rail-nav', { hasText: '套餐与余额' }).click()
  await win.locator('.rail-nav', { hasText: '设置' }).click()
  await win.locator('.page-tabs button', { hasText: '聊天翻译' }).click()

  await expect(win.locator('label.field.checkbox', { hasText: '自动翻译收到的消息' }).locator('input')).toBeChecked({ checked: inbTarget })
  await expect(win.locator('label.field.checkbox', { hasText: '发送前预览译文确认' }).locator('input')).toBeChecked({ checked: cfmTarget })
  await expect(win.locator('label.field', { hasText: '我的本地语言' }).locator('select')).toHaveValue(chosenLang)

  await app.close()
})
