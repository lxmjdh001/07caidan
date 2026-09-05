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

test('客户端代理平台目录：按全球和中国分类展示后台配置', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'omni-proxy-vendors-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN],
    env: { ...process.env, OMNI_USER_DATA: userData }
  })

  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    await win.locator('.auth-switch button').first().click()
    await win.locator('input[type="email"]').fill(`proxy_${Date.now().toString(36)}@e2e.test`)
    await win.locator('input[type="password"]').fill('secret123')
    await win.locator('.auth-submit').click()
    await expect(win.locator('.account-settings-trigger')).toBeVisible({ timeout: 20_000 })

    await win.locator('.account-settings-trigger').click()
    await win.locator('.account-settings-menu button', { hasText: '管理中心' }).click()
    await win.locator('.management-card', { hasText: '代理 IP 管理' }).click()

    await expect(win.getByRole('heading', { name: '代理 IP 管理' })).toBeVisible()
    await expect(win.getByRole('tab', { name: '代理列表' })).toHaveAttribute('aria-selected', 'true')

    await win.getByRole('tab', { name: '全球代理' }).click()
    await expect(win.getByRole('heading', { name: '全球代理平台' })).toBeVisible()
    await expect(win.locator('.proxy-market-card')).toHaveCount(8)
    await expect(win.locator('.proxy-market-card', { hasText: 'NovProxy' })).toBeVisible()
    await expect(win.locator('.proxy-market-card', { hasText: '1024proxy' })).toBeVisible()
    await expect(win.locator('.proxy-market-card', { hasText: 'IPIPD' }).locator('a')).toHaveAttribute('target', '_blank')

    await win.getByRole('tab', { name: '中国代理' }).click()
    await expect(win.getByRole('heading', { name: '中国代理平台' })).toBeVisible()
    await expect(win.locator('.proxy-market-card')).toHaveCount(4)
    await expect(win.locator('.proxy-market-card', { hasText: '闪臣 HTTP' })).toBeVisible()
    await expect(win.locator('.proxy-market-card', { hasText: '星空代理' })).toBeVisible()
    await expect(win.locator('.proxy-market-card', { hasText: '花生 HTTP' })).toBeVisible()

    await win.screenshot({ path: `${SHOT_DIR}/client-proxy-vendors.png` })
  } finally {
    await app.close()
  }
})
