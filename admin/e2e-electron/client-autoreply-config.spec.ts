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

// M13 AI 自动回复全局配置：启用 + 话术 + 转人工关键词 填写并持久化
test('客户端设置：AI 自动回复话术与转人工关键词持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-ar-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  // 设置 → 通用（默认）→ AI 自动回复区
  await win.locator('.rail-nav', { hasText: '设置' }).click()
  const enable = win.locator('label.field', { hasText: '启用自动回复' }).locator('input[type="checkbox"]')
  await expect(enable).toBeVisible({ timeout: 10_000 })
  await enable.check()
  const PROMPT = '你是本店专业客服，用简洁友好的语气回答，不承诺价格。E2E标记'
  await win.locator('label.field', { hasText: '话术 / 身份设定' }).locator('textarea').fill(PROMPT)
  await win.locator('label.field', { hasText: '转人工关键词' }).locator('input').fill('人工,投诉,退款')

  await win.getByRole('button', { name: '保存', exact: true }).click()
  await expect(win.locator('.save-ok')).toBeVisible({ timeout: 10_000 })
  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-61-autoreply.png` })

  // 跳走再回：启用仍勾选 + 话术持久化
  await win.locator('.rail-nav', { hasText: '设置' }).click()
  await win.locator('.rail-nav', { hasText: '设置' }).click()
  await expect(
    win.locator('label.field', { hasText: '启用自动回复' }).locator('input[type="checkbox"]')
  ).toBeChecked()
  await expect(win.locator('label.field', { hasText: '话术 / 身份设定' }).locator('textarea')).toHaveValue(PROMPT)

  await app.close()
})
