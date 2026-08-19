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

// M10 Click-to-WhatsApp 广告归因(via='ad')：会话头来源标签 + tooltip 带广告落地 URL
test('客户端聊天：CtwA 广告来源标签含广告 URL', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:ctwa'
  const adUrl = 'https://fb.com/ads/summer-xyz'
  const store = {
    version: 1,
    conversations: {
      [cid]: {
        id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'ctwa',
        title: '广告客户E2E', contactId: 'wa:+15559990010', isGroup: false,
        leadSource: { code: 'ctwa-clid', via: 'ad', clickId: 'CLICK123', sourceUrl: adUrl, title: 'Meta夏季广告E2E' },
        lastMessageAt: now, lastMessagePreview: '看到广告', unreadCount: 1
      }
    },
    messages: {
      [cid]: [{ id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'text', text: '看到你的广告来的' }, timestamp: now, status: 'delivered' }]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-ctwa-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.conversation-item', { hasText: '广告客户E2E' }).click()

  // 来源标签：来自 Meta夏季广告E2E；tooltip(title) 为广告落地 URL（CtwA 最可靠归因）
  const chip = win.locator('.source-chip')
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await expect(chip).toContainText('Meta夏季广告E2E')
  await expect(chip).toHaveAttribute('title', adUrl)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-69-ctwa-source.png` })
  await app.close()
})
