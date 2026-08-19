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

// Telegram 普通账号(MTProto/phone_code) —— 打粉主推渠道：选账号后弹出扫码/手机号登录 UI
test('客户端添加 Telegram 普通账号：弹出扫码/手机号登录切换', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-tguser-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  // + → 选「Telegram（账号）」普通账号（区别于 Telegram Bot）
  await win.getByTitle('添加 WhatsApp 账号').click()
  await win.locator('.picker-item', { hasText: 'Telegram（账号）' }).click()

  // 账号弹窗：phone_code 类型显示「扫码登录 / 手机号登录」切换，且带保存并连接
  const modal = win.locator('.modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  const tabs = modal.locator('.login-tabs')
  await expect(tabs.getByRole('button', { name: '扫码登录' })).toBeVisible()
  await expect(tabs.getByRole('button', { name: '手机号登录' })).toBeVisible()
  // 有「保存并连接」（phone_code 与 credentials 都需要）
  await expect(modal.getByRole('button', { name: '保存并连接' })).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-42-tg-user.png` })
  await app.close()
})
