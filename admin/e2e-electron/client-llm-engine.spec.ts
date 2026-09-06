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

// M2/M12 翻译引擎 LLM(OpenAI 兼容)：选 LLM 引擎浮现接口地址/模型/Key 条件字段并持久化
test('客户端翻译设置：LLM 引擎条件字段填写并持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-llm-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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
  await win.getByTestId('client-nav-settings').click()
  await win.locator('.page-tabs button', { hasText: '聊天翻译' }).click()

  // 选 LLM 引擎
  const engineSel = win.locator('label.field', { hasText: '翻译引擎' }).locator('select')
  await engineSel.selectOption('llm')

  // 条件字段浮现：接口地址(OpenAI 兼容) / 模型名称 / API Key
  const baseUrl = win.locator('label.field', { hasText: '接口地址' }).locator('input')
  await expect(baseUrl).toBeVisible({ timeout: 10_000 })
  await baseUrl.fill('https://api.test.local/v1')
  await win.locator('label.field', { hasText: '模型名称' }).locator('input').fill('gpt-e2e-mini')
  await win.locator('label.field', { hasText: 'API Key' }).locator('input').fill('sk-e2e-secret')

  await win.getByRole('button', { name: '保存', exact: true }).click()
  await expect(win.locator('.save-ok')).toBeVisible({ timeout: 10_000 })
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-56-llm-engine.png` })

  // 跳走再回：引擎仍 LLM，接口地址持久化
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  await win.locator('.page-tabs button', { hasText: '聊天翻译' }).click()
  await expect(win.locator('label.field', { hasText: '翻译引擎' }).locator('select')).toHaveValue('llm')
  await expect(win.locator('label.field', { hasText: '接口地址' }).locator('input')).toHaveValue('https://api.test.local/v1')

  await app.close()
})
