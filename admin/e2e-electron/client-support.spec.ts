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

test('客户端帮助与反馈：提交支持工单并在列表核对', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-sup-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.locator('.rail-nav', { hasText: '帮助与反馈' }).click()
  await win.getByRole('button', { name: '提交问题' }).first().click()

  // 填标题 + 描述 → 提交
  await win.locator('input[type="text"]').first().fill('E2E 反馈测试')
  await win.locator('textarea').first().fill('这是一条端到端测试的软件问题反馈。')
  await win.getByRole('button', { name: '提交', exact: true }).click()

  // 列表出现该工单
  await expect(win.getByText('E2E 反馈测试').first()).toBeVisible({ timeout: 10_000 })
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-23-support.png` })
  await app.close()
})
