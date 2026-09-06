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

// 红线（XSS 安全）：客户发来的消息含 HTML/JS 时必须按纯文本转义显示，绝不执行。
// 打粉客服会收到大量不可信客户内容，若渲染成 HTML 就是 XSS 洞。
test('客户端聊天：恶意消息内容按纯文本转义、不执行', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const now = Date.now()
  const cid = 'whatsapp:main:xss'
  const payload = '<img src=x onerror="window.__XSS_FIRED=true"><script>window.__XSS2=1<\/script>危险内容'
  const store = {
    version: 1,
    conversations: { [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'xss', title: '注入客户E2E', contactId: 'wa:+15559990088', isGroup: false, lastMessageAt: now, lastMessagePreview: 'x', unreadCount: 0 } },
    messages: { [cid]: [{ id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'text', text: payload }, timestamp: now, status: 'delivered' }] }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-xss-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.conversation-item', { hasText: '注入客户E2E' }).click()

  // 气泡把 payload 当纯文本显示（含字面 <img / onerror）
  const bubble = win.locator('.bubble-text', { hasText: '危险内容' })
  await expect(bubble).toBeVisible({ timeout: 10_000 })
  await expect(bubble).toContainText('<img src=x onerror=')
  // 未注入真实元素、未执行脚本
  await expect(win.locator('.bubble-text img')).toHaveCount(0)
  const fired = await win.evaluate(() => (window as unknown as { __XSS_FIRED?: boolean; __XSS2?: number }).__XSS_FIRED ?? false)
  const xss2 = await win.evaluate(() => (window as unknown as { __XSS2?: number }).__XSS2 ?? 0)
  expect(fired).toBeFalsy()
  expect(xss2).toBe(0)

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-113-msg-xss-safe.png` })
  await app.close()
})
