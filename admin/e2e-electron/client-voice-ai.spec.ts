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

// M1 语音条转文字 + M13 AI 自动回复气泡角标：预置本地会话验证两种特殊气泡渲染
test('客户端聊天：语音转写文本与 AI 自动回复角标渲染', async () => {
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  const now = Date.now()
  const cid = 'whatsapp:main:voiceai'
  const store = {
    version: 1,
    conversations: {
      [cid]: {
        id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'voiceai',
        title: '语音客户E2E', contactId: 'wa:+15559990003', isGroup: false,
        lastMessageAt: now, lastMessagePreview: '[语音]', unreadCount: 1
      }
    },
    messages: {
      [cid]: [
        // 入站语音 + 已转写文本
        { id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in',
          body: { type: 'media', mediaType: 'audio', mediaId: 'voice-fake-1', durationSec: 6, transcript: '你好，这个产品怎么卖？' },
          timestamp: now - 120_000, status: 'delivered' },
        // 出站 AI 自动回复
        { id: 'm2', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'out',
          origin: 'autoreply', body: { type: 'text', text: '您好，这款目前 99 元，需要我发下单链接吗？' },
          timestamp: now, status: 'sent' }
      ]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-voiceai-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.conversation-item', { hasText: '语音客户E2E' }).click()

  // 入站语音气泡的转写文本
  await expect(win.locator('.voice-msg').first()).toBeVisible({ timeout: 10_000 })
  await expect(win.locator('.voice-transcript')).toContainText('你好，这个产品怎么卖？')
  // 出站 AI 自动回复气泡带「AI」角标
  const aiRow = win.locator('.bubble-row.out').filter({ hasText: '99 元' })
  await expect(aiRow.locator('.ai-chip')).toHaveText('AI')

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-35-voice-ai.png` })
  await app.close()
})
