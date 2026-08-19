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

// M2 出站气泡双显：发给客户的译文 + 坐席原文（标「原文」）都显示
test('客户端聊天：出站气泡译文+坐席原文双显', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:outtr'
  const store = {
    version: 1,
    conversations: {
      [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'outtr', title: '双显客户E2E', contactId: 'wa:+15559990012', isGroup: false, lastMessageAt: now, lastMessagePreview: 'Sure', unreadCount: 0 }
    },
    messages: {
      [cid]: [
        // 出站：body.text 是发给客户的译文；translation.text 是坐席原文（标"原文"）
        { id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'out',
          body: { type: 'text', text: 'Sure, it is in stock!' },
          translation: { text: '有货的，坐席原文E2E', targetLang: 'en', engine: 'google-free' },
          timestamp: now, status: 'sent' }
      ]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-outtr-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.conversation-item', { hasText: '双显客户E2E' }).click()

  // 出站气泡：主体是发出的译文；下方双显坐席原文并标「原文」
  const row = win.locator('.bubble-row.out').filter({ hasText: 'Sure, it is in stock!' })
  await expect(row).toBeVisible({ timeout: 10_000 })
  const tr = row.locator('.bubble-translation')
  await expect(tr).toContainText('有货的，坐席原文E2E')
  await expect(tr).toContainText('原文')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-72-outbound-translation.png` })
  await app.close()
})
