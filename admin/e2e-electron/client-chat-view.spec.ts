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

// M5 客户端聊天视图：预置本地会话，验证收/发气泡 + 行内译文渲染（客户端侧归档查看）
test('客户端聊天视图：本地会话收发气泡与译文渲染', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:custE2E'
  const store = {
    version: 1,
    conversations: {
      [cid]: {
        id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'custE2E',
        title: '本地客户E2E', contactId: 'wa:+15559990001', isGroup: false,
        lastMessageAt: now, lastMessagePreview: '这个怎么买？多少钱', unreadCount: 1
      }
    },
    messages: {
      [cid]: [
        { id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in',
          body: { type: 'text', text: '这个怎么买？多少钱' },
          translation: { text: 'How do I buy this? How much?', targetLang: 'en', engine: 'google-free' },
          timestamp: now - 60_000, status: 'delivered' },
        { id: 'm2', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'out',
          body: { type: 'text', text: 'Just tap the buy link!' }, timestamp: now, status: 'sent' }
      ]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-chatview-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  // 启动公告弹窗可能挡住界面（共享租户里别的用例发过全员公告），先关掉
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) {
    await gotIt.click()
    await expect(gotIt).toBeHidden()
  }

  // 预置的会话出现在列表 → 点开
  await win.locator('.conversation-item', { hasText: '本地客户E2E' }).click()

  // 入站气泡：原文 + 行内译文
  const inRow = win.locator('.bubble-row.in').filter({ hasText: '这个怎么买？多少钱' })
  await expect(inRow).toBeVisible({ timeout: 10_000 })
  await expect(inRow.locator('.bubble-translation')).toContainText('How do I buy this?')
  // 出站气泡
  await expect(win.locator('.bubble-row.out').filter({ hasText: 'Just tap the buy link!' })).toBeVisible()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-33-chat-view.png` })
  await app.close()
})
