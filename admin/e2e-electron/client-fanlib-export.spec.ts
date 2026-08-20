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

// M9 重粉库第二条建库路径：从历史会话导出建库（区别于粘贴名单导入）
test('客户端重粉库：从历史导出建库并在列表核对', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-libexp-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  // 关掉可能的启动公告弹窗（共享租户里别的用例发过全员公告，居中弹层会挡住页签点击）
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  await win.locator('.rail-nav', { hasText: '引流工单' }).click()
  await win.getByRole('button', { name: '重粉库' }).click()

  const libName = `历史导出库${Date.now().toString(36).slice(-4)}`
  const card = win.locator('section.form-card').filter({ hasText: '新建重粉库' })
  // 「从历史导出」为默认模式；显式点一下确保选中
  await card.getByRole('button', { name: '从历史导出' }).click()
  await card.locator('input[type="text"]').first().fill(libName)
  // 平台默认 whatsapp；直接导出建库
  await card.getByRole('button', { name: '导出建库' }).click()

  // 导出结果提示（新老板无历史时 0 个，共享租户可能有历史，故只校验文案形态）
  // 满负载连跑 128 个 Electron 时服务端往返可能 >20s，给足余量到 30s（历史导出扫全库较重）
  await expect(card.getByText(/已导出 \d+ 个客户/)).toBeVisible({ timeout: 30_000 })
  // 已有重粉库列表出现该库（同为导出后的服务端往返，超时与上面对齐 30s）
  await expect(win.getByText(libName).first()).toBeVisible({ timeout: 30_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-32-fanlib-export.png` })
  await app.close()
})
