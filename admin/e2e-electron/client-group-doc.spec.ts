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

// 群聊发送者名(authorName) + 文件气泡(.media-doc) 渲染
test('客户端聊天：群聊显示发送者名 + 文件消息气泡', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:grp1'
  const store = {
    version: 1,
    conversations: {
      [cid]: {
        id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'grp1',
        title: '询价群E2E', isGroup: true,
        lastMessageAt: now, lastMessagePreview: '[文件]', unreadCount: 2
      }
    },
    messages: {
      [cid]: [
        { id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in',
          authorName: '张三', body: { type: 'text', text: '群里有人问价格' }, timestamp: now - 120_000, status: 'delivered' },
        { id: 'm2', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in',
          authorName: '李四', body: { type: 'media', mediaType: 'document', mediaId: 'doc1.pdf', fileName: '2026报价单.pdf' },
          timestamp: now, status: 'delivered' }
      ]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-grpdoc-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.conversation-item', { hasText: '询价群E2E' }).click()

  // 群聊：入站气泡显示发送者名
  await expect(win.locator('.bubble-author', { hasText: '张三' })).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('.bubble-author', { hasText: '李四' })).toBeVisible()
  // 文件气泡：📄 + 文件名
  const doc = win.locator('.media-doc')
  await expect(doc).toBeVisible()
  await expect(doc).toContainText('2026报价单.pdf')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-38-group-doc.png` })
  await app.close()
})
