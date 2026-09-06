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

// 头牌功能「双向自动翻译」的配置页：切换翻译引擎并核对持久化（跳走再回来仍生效）
test('客户端翻译设置：切换翻译引擎并跨导航持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-trans-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  // 侧栏「设置」→「聊天翻译」页签
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  await win.locator('.page-tabs button', { hasText: '聊天翻译' }).click()

  // 翻译引擎下拉
  const engineSel = win.locator('label.field', { hasText: '翻译引擎' }).locator('select')
  await expect(engineSel).toBeVisible({ timeout: 10_000 })
  const before = await engineSel.inputValue()
  // 切到另一个引擎（下拉至少含 google-free / deepl / 官方云 / LLM 多项）
  await engineSel.selectOption({ index: 1 })
  const after = await engineSel.inputValue()
  expect(after).not.toBe(before)

  // 保存 → 出现「已保存」
  await win.getByRole('button', { name: '保存' }).click()
  await expect(win.locator('.save-ok')).toBeVisible({ timeout: 10_000 })
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-27-translation.png` })

  // 跳去聊天再回设置：引擎仍是切换后的值（证明真落盘，非仅本地态）
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click() // 切回聊天
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click() // 再进设置
  await win.locator('.page-tabs button', { hasText: '聊天翻译' }).click()
  const persisted = win.locator('label.field', { hasText: '翻译引擎' }).locator('select')
  await expect(persisted).toHaveValue(after)

  await app.close()
})
