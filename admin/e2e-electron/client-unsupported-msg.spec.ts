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

// 不支持的消息类型（位置/名片/投票等）优雅降级：气泡显示「[暂不支持的消息: 描述]」，不崩不空。
// media-image/group-doc 覆盖了图片/文件，unsupported 兜底渲染此前没测。
test('客户端聊天：不支持的消息类型显示占位提示', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const now = Date.now()
  const cid = 'whatsapp:main:unsup'
  const store = {
    version: 1,
    conversations: { [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'unsup', title: '位置客户E2E', contactId: 'wa:+15559990055', isGroup: false, lastMessageAt: now, lastMessagePreview: '[位置]', unreadCount: 0 } },
    messages: { [cid]: [
      { id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'text', text: '发你个位置' }, timestamp: now - 1000, status: 'delivered' },
      { id: 'm2', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'unsupported', description: '位置分享' }, timestamp: now, status: 'delivered' }
    ] }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-unsup-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.conversation-item', { hasText: '位置客户E2E' }).click()
  // 不支持消息优雅降级为占位文本；文本消息仍正常
  await expect(win.getByText('发你个位置')).toBeVisible({ timeout: 10_000 })
  await expect(win.getByText('[暂不支持的消息: 位置分享]')).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-108-unsupported-msg.png` })
  await app.close()
})
