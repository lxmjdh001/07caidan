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

function seed(): void {
  const convId = 'whatsapp:acc1:88800001@s.whatsapp.net'
  const now = Date.now()
  const store = {
    version: 1,
    conversations: {
      [convId]: { id: convId, channel: 'whatsapp', accountId: 'acc1', externalChatId: '88800001@s.whatsapp.net', title: '高意向客户', isGroup: false, lastMessageAt: now, lastMessagePreview: '这个多少钱？怎么买', unreadCount: 0 }
    },
    messages: {
      [convId]: [
        { id: 'm1', channel: 'whatsapp', accountId: 'acc1', conversationId: convId, direction: 'in', body: { type: 'text', text: '这个多少钱？怎么买' }, timestamp: now - 30_000, status: 'delivered' }
      ]
    }
  }
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')
}

test('客户端聊天头部显示本地意向标签（高意向）', async () => {
  seed()
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-intent-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()

  await win.locator('.account-row.all').click()

  await expect(win.locator('.conversation-item').first()).toBeVisible({ timeout: 20_000 })
  await win.locator('.conversation-item').first().click()
  // 聊天头部出现「高意向」标签（本地关键词判定）
  await expect(win.locator('.chat-header .intent-chip.intent-high')).toHaveText('高意向', { timeout: 10_000 })
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-11-intent-chip.png` })
  await app.close()
})
