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

// 未读角标：会话 unreadCount 在列表项与账号栏聚合处显示数字
test('客户端会话列表：未读角标显示数字', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:unread'
  const store = {
    version: 1,
    conversations: {
      [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'unread', title: '未读客户E2E', isGroup: false, lastMessageAt: now, lastMessagePreview: '在吗在吗', unreadCount: 5 }
    },
    messages: {
      [cid]: [{ id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'text', text: '在吗在吗' }, timestamp: now, status: 'delivered' }]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-unread-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  // 会话项未读角标 = 5
  const convBadge = win.locator('.conversation-item', { hasText: '未读客户E2E' }).locator('.unread-badge')
  await expect(convBadge).toHaveText('5', { timeout: 10_000 })
  // 账号栏至少有一处未读角标（聚合/按账号）
  await expect(win.locator('.unread-badge').first()).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-40-unread-badge.png` })

  // 点开会话即清零未读（markRead）
  await win.locator('.conversation-item', { hasText: '未读客户E2E' }).click()
  await expect(convBadge).toHaveCount(0, { timeout: 10_000 })

  await app.close()
})
