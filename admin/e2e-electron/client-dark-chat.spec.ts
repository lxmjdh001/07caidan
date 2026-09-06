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

// M8 深色主题下聊天区（收发气泡+译文）对比度人工校对 —— 此前深色截图只覆盖团队/登录页
test('客户端深色主题：聊天气泡与译文对比度截图核对', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN', theme: 'dark' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:darkchat'
  const store = {
    version: 1,
    conversations: {
      [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'darkchat', title: '深色客户E2E', contactId: 'wa:+15559990006', isGroup: false, lastMessageAt: now, lastMessagePreview: '晚上好', unreadCount: 1 }
    },
    messages: {
      [cid]: [
        { id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in',
          body: { type: 'text', text: '晚上好，还能下单吗？' },
          translation: { text: 'Good evening, can I still order?', targetLang: 'en', engine: 'google-free' },
          timestamp: now - 60_000, status: 'delivered' },
        { id: 'm2', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'out',
          body: { type: 'text', text: 'Sure, the link is ready!' }, timestamp: now, status: 'sent' }
      ]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-darkchat-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })

  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 深色主题已生效（根节点 data-theme=dark）
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark')

  await win.locator('.account-row.all').click()

  await win.locator('.conversation-item', { hasText: '深色客户E2E' }).click()
  await expect(win.locator('.bubble-row.in').filter({ hasText: '晚上好' })).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('.bubble-row.out').filter({ hasText: 'Sure, the link is ready!' })).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-41-dark-chat.png` })
  await app.close()
})
