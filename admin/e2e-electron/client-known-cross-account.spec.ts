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

// M9 跨账号老客识别：同一 contactId 在另一账号也联系过 → 会话头显示「已在其他账号联系过」。
// 这是打粉重要提示（看似新粉其实是老客），此前没有 e2e 覆盖。
test('客户端聊天：同一客户在其他账号联系过时头部提示', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')

  const now = Date.now()
  const contact = 'wa:+15559990044' // 同一个人
  const cidA = 'whatsapp:main:crossA'
  const cidB = 'whatsapp:acc2:crossB' // 不同账号，同一 contactId
  const store = {
    version: 1,
    conversations: {
      [cidA]: { id: cidA, channel: 'whatsapp', accountId: 'main', externalChatId: 'crossA', title: '甲号客户E2E', contactId: contact, isGroup: false, lastMessageAt: now, lastMessagePreview: 'hi A' },
      [cidB]: { id: cidB, channel: 'whatsapp', accountId: 'acc2', externalChatId: 'crossB', title: '乙号客户E2E', contactId: contact, isGroup: false, lastMessageAt: now - 5000, lastMessagePreview: 'hi B' }
    },
    messages: {
      [cidA]: [{ id: 'a1', channel: 'whatsapp', accountId: 'main', conversationId: cidA, direction: 'in', body: { type: 'text', text: 'hi A' }, timestamp: now, status: 'delivered' }],
      [cidB]: [{ id: 'b1', channel: 'whatsapp', accountId: 'acc2', conversationId: cidB, direction: 'in', body: { type: 'text', text: 'hi B' }, timestamp: now - 5000, status: 'delivered' }]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-cross-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  // 打开甲号会话 → 头部出现「已在其他账号联系过」老客提示
  await win.locator('.account-row.all').click()

  await win.locator('.conversation-item', { hasText: '甲号客户E2E' }).click()
  await expect(win.locator('.known-chip', { hasText: '已在其他账号联系过' })).toBeVisible({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-107-known-cross-account.png` })
  await app.close()
})
