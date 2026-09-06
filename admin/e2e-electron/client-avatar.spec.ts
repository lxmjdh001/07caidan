import { test, expect, _electron as electron } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const REPO = resolve(CLIENT_DIR, '..')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const ELECTRON_PATH = createRequire(join(CLIENT_DIR, 'package.json'))('electron') as string
const USER_DATA = mkdtempSync(join(tmpdir(), 'omni-e2e-'))

// 会话头像：avatarMediaId 经 omni-media 协议渲染真实头像图（非首字母占位）
test('客户端会话列表：头像图经媒体协议渲染', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  mkdirSync(join(USER_DATA, 'media'), { recursive: true })
  copyFileSync(join(REPO, 'branding', 'default', 'icon.png'), join(USER_DATA, 'media', 'avatar-e2e.png'))
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:avatar'
  const store = {
    version: 1,
    conversations: {
      [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'avatar', title: '头像客户E2E', contactId: 'wa:+15559990009', avatarMediaId: 'avatar-e2e.png', isGroup: false, lastMessageAt: now, lastMessagePreview: 'hi', unreadCount: 0 }
    },
    messages: {
      [cid]: [{ id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'text', text: 'hi' }, timestamp: now, status: 'delivered' }]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-avatar-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  // 会话列表里该会话头像是图片(.avatar-img)且真解码出像素
  await win.locator('.account-row.all').click()

  const img = win.locator('.conversation-item', { hasText: '头像客户E2E' }).locator('img.avatar-img')
  await expect(img).toBeVisible({ timeout: 10_000 })
  await expect(async () => {
    const nw = await img.evaluate((el: HTMLImageElement) => el.naturalWidth)
    expect(nw).toBeGreaterThan(0)
  }).toPass({ timeout: 10_000 })

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-68-avatar.png` })
  await app.close()
})
