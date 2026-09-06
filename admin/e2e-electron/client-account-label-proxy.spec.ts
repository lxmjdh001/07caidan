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

// 账号资料与代理已拆成两个独立入口；分别核对保存与回显。
test('客户端账号设置：备注名与代理分开配置并持久化', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-acclp-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  const label = `销售组A${Date.now().toString(36).slice(-4)}`
  const proxy = 'socks5://127.0.0.1:1080'
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

  const accRow = win.locator('.account-row').filter({ has: win.locator('.account-row-more') }).first()
  await accRow.hover()
  await accRow.locator('.account-row-more').click()
  await win.locator('.account-context-menu').getByRole('button', { name: '编辑' }).click()
  const modal = win.locator('.modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })

  // 编辑页只处理账号资料，不重复展示代理字段。
  await modal.locator('label.field', { hasText: '备注名' }).locator('input').fill(label)
  await expect(modal.getByText('代理服务器')).toHaveCount(0)

  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-87-account-label-proxy.png` })

  await modal.getByRole('button', { name: '保存', exact: true }).click()
  await expect(modal).toBeHidden({ timeout: 10_000 })

  // 备注名回显到侧栏账号行（成为账号显示名）
  await expect(win.getByText(label).first()).toBeVisible({ timeout: 10_000 })

  // 重开编辑 → 备注名仍在（落库）
  await accRow.hover()
  await accRow.locator('.account-row-more').click()
  await win.locator('.account-context-menu').getByRole('button', { name: '编辑' }).click()
  const modal2 = win.locator('.modal')
  await expect(modal2.locator('label.field', { hasText: '备注名' }).locator('input')).toHaveValue(label)
  await modal2.locator('.account-modal-footer .ghost-btn').click()

  // 代理配置走独立入口；保存不强制先检测，平台连接结果不作为保存前置。
  await accRow.hover()
  await accRow.locator('.account-row-more').click()
  await win.locator('.account-context-menu').getByRole('button', { name: '代理配置' }).click()
  const proxyModal = win.locator('.proxy-config-modal')
  await proxyModal.locator('input[placeholder="IP:端口 或 IP:端口:账号:密码"]').fill(proxy)
  await proxyModal.getByRole('button', { name: '保存并连接' }).click()
  await win.waitForTimeout(300)
  if (await proxyModal.isVisible().catch(() => false)) {
    await proxyModal.locator('.account-modal-footer .ghost-btn').click()
  }

  await accRow.hover()
  await accRow.locator('.account-row-more').click()
  await win.locator('.account-context-menu').getByRole('button', { name: '代理配置' }).click()
  await expect(win.locator('.proxy-config-modal input[placeholder="IP:端口 或 IP:端口:账号:密码"]')).toHaveValue('127.0.0.1:1080')

  await app.close()
})
