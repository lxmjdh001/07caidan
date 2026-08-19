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

// 打开会话清未读：选中会话触发 api.markRead → unreadCount 归 0、角标消失。
// unread-badge 只验角标显示数字，打开清零这条交互此前没测。
test('客户端会话列表：打开会话后未读角标清零', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:unreadclr'
  const store = {
    version: 1,
    conversations: {
      [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'unreadclr', title: '待读客户E2E', isGroup: false, lastMessageAt: now, lastMessagePreview: '在吗在吗', unreadCount: 5 }
    },
    messages: {
      [cid]: [{ id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'text', text: '在吗在吗' }, timestamp: now, status: 'delivered' }]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-unreadclr-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  const item = win.locator('.conversation-item', { hasText: '待读客户E2E' })
  // 打开前：角标 = 5
  await expect(item.locator('.unread-badge')).toHaveText('5', { timeout: 10_000 })

  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-92-unread-before.png` })

  // 打开会话 → 触发已读 → 角标消失
  await item.click()
  await expect(win.locator('.bubble-row', { hasText: '在吗在吗' }).first()).toBeVisible({ timeout: 10_000 })
  await expect(item.locator('.unread-badge')).toHaveCount(0, { timeout: 10_000 })

  await app.close()
})
