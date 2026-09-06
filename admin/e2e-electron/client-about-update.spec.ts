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

// M16 关于/检查更新面板：显示真实版本号 + 检查更新按钮可点（未打包=开发禁用，状态稳定）
test('客户端关于面板：显示版本号且「检查更新」可点', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-about-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  // 侧栏「设置」→ 通用页签默认打开，底部即「关于」区
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  await expect(win.getByRole('heading', { name: '关于' })).toBeVisible({ timeout: 10_000 })

  // 版本号是真实 semver（来自 app.getVersion）
  const versionRow = win.locator('.about-row')
  await expect(versionRow).toContainText(/v\d+\.\d+\.\d+/)

  // 「检查更新」按钮可点；未打包=开发模式禁用，点击不改状态、不崩
  await win.getByRole('button', { name: '检查更新' }).click()
  await win.waitForTimeout(500)
  await expect(win.getByText('有新版本时会自动在后台下载，退出时自动完成安装。')).toBeVisible()

  await win.screenshot({ path: `${SHOT_DIR}/client-28-about.png` })
  await app.close()
})
