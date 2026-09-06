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

// 意向标签 show/hide 门槛（intent && intent !== 'low'）：提问类→中意向标签显示；无关键词→low→不显示。
// client-intent 只覆盖高意向，中意向显示 + 低意向不显示这条门槛此前没测。
test('客户端聊天：中意向显示标签、低意向不显示标签', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const now = Date.now()
  const mid = 'whatsapp:main:mid'
  const low = 'whatsapp:main:low'
  const store = {
    version: 1,
    conversations: {
      [mid]: { id: mid, channel: 'whatsapp', accountId: 'main', externalChatId: 'mid', title: '中意向客户E2E', contactId: 'wa:+15559990091', isGroup: false, lastMessageAt: now, lastMessagePreview: '有货吗', unreadCount: 0 },
      [low]: { id: low, channel: 'whatsapp', accountId: 'main', externalChatId: 'low', title: '低意向客户E2E', contactId: 'wa:+15559990092', isGroup: false, lastMessageAt: now - 5000, lastMessagePreview: '你好', unreadCount: 0 }
    },
    messages: {
      [mid]: [{ id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: mid, direction: 'in', body: { type: 'text', text: '这个有货吗？' }, timestamp: now, status: 'delivered' }],
      [low]: [{ id: 'l1', channel: 'whatsapp', accountId: 'main', conversationId: low, direction: 'in', body: { type: 'text', text: '你好呀' }, timestamp: now - 5000, status: 'delivered' }]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-intlvl-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  // 中意向会话 → 头部显示「中意向」标签
  await win.locator('.account-row.all').click()

  await win.locator('.conversation-item', { hasText: '中意向客户E2E' }).click()
  await expect(win.locator('.chat-header .intent-chip.intent-medium')).toHaveText('中意向', { timeout: 10_000 })
  await win.waitForTimeout(200)
  await win.screenshot({ path: `${SHOT_DIR}/client-118-intent-levels.png` })

  // 低意向会话 → 头部不显示任何意向标签
  await win.locator('.conversation-item', { hasText: '低意向客户E2E' }).click()
  await expect(win.locator('.chat-header')).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('.chat-header .intent-chip')).toHaveCount(0)

  await app.close()
})
