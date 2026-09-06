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

// M1 发送状态回执：出站气泡按 status 显示 ✓（已送达）/ ✗ 发送失败
test('客户端聊天：出站消息状态回执渲染（含发送失败）', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:status'
  const store = {
    version: 1,
    conversations: {
      [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'status', title: '回执客户E2E', contactId: 'wa:+15559990008', isGroup: false, lastMessageAt: now, lastMessagePreview: '失败的消息', unreadCount: 0 }
    },
    messages: {
      [cid]: [
        { id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'out', body: { type: 'text', text: '已送达的消息OK' }, timestamp: now - 60_000, status: 'read' },
        { id: 'm2', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'out', body: { type: 'text', text: '这条发送失败了' }, timestamp: now, status: 'failed' }
      ]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-status-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.account-row.all').click()

  await win.locator('.conversation-item', { hasText: '回执客户E2E' }).click()

  // 已送达(read)出站气泡：✓
  const okRow = win.locator('.bubble-row.out').filter({ hasText: '已送达的消息OK' })
  await expect(okRow.locator('.tick.read')).toHaveText('✓', { timeout: 10_000 })
  // 失败出站气泡：✗ 发送失败
  const failRow = win.locator('.bubble-row.out').filter({ hasText: '这条发送失败了' })
  await expect(failRow.locator('.tick.failed')).toContainText('发送失败')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-67-msg-status.png` })
  await app.close()
})
