import { test, expect, _electron as electron } from '@playwright/test'
import { createServer, type Server } from 'node:http'
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

// 起一个确定性的 custom-http 翻译桩：主进程会 fetch 它做出站翻译
// 契约（见 custom-http.ts）：POST {text, target_lang} -> {text, source_lang}
function startStub(): Promise<{ server: Server; url: string; hits: Array<{ text: string; target_lang: string }> }> {
  const hits: Array<{ text: string; target_lang: string }> = []
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        let body: { text?: string; target_lang?: string } = {}
        try { body = JSON.parse(raw) } catch { /* ignore */ }
        hits.push({ text: String(body.text ?? ''), target_lang: String(body.target_lang ?? '') })
        // 译文与原文不同 -> pipeline 认定“发生了翻译”，engine 生效，预览面板才会出现
        resp.writeHead(200, { 'content-type': 'application/json' })
        resp.end(JSON.stringify({ text: `EN[${body.target_lang}] ${body.text}`, source_lang: 'zh' }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      res({ server, url: `http://127.0.0.1:${port}`, hits })
    })
  })
}

// M2 出站翻译“发送前预览确认”：坐席点发送 → 先弹译文预览（目标语 + 译文 + 确认发送），确认后才真正发
// 既有 outbound-translation/chat-view 都是「灌好成品消息」验展示，从未走过实时预览确认这条交互链。
test('客户端聊天：出站翻译发送前预览确认面板', async () => {
  const stub = await startStub()
  mkdirSync(join(USER_DATA, 'data'), { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({
    locale: 'zh-CN',
    translation: {
      engine: 'custom-http',
      outboundEnabled: true,
      inboundEnabled: false,
      confirmBeforeSend: true,
      custom: { url: stub.url, apiKey: '' }
    }
  }), 'utf8')

  const now = Date.now()
  const cid = 'whatsapp:main:preview'
  const store = {
    version: 1,
    conversations: {
      [cid]: { id: cid, channel: 'whatsapp', accountId: 'main', externalChatId: 'preview', title: '预览客户E2E', contactId: 'wa:+15559990022', langOverride: 'en', isGroup: false, lastMessageAt: now, lastMessagePreview: 'hello?', unreadCount: 0 }
    },
    messages: {
      [cid]: [{ id: 'm1', channel: 'whatsapp', accountId: 'main', conversationId: cid, direction: 'in', body: { type: 'text', text: 'do you have stock?' }, timestamp: now, status: 'delivered' }]
    }
  }
  writeFileSync(join(USER_DATA, 'data', 'store.json'), JSON.stringify(store), 'utf8')

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-preview-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
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

  await win.locator('.conversation-item', { hasText: '预览客户E2E' }).click()

  // 坐席输入中文 → 点发送 → 因开启“发送前确认”，先出译文预览面板（未真正发送）
  const draft = '在吗 现在有货吗'
  await win.locator('.composer textarea').fill(draft)
  await win.locator('.send-btn').click()

  const preview = win.locator('.send-preview')
  await expect(preview).toBeVisible({ timeout: 10_000 })
  // 面板展示确定性译文（桩返回 EN[en] 前缀）与目标语，且给出「确认发送」按钮
  await expect(preview.locator('.send-preview-text')).toHaveText(`EN[en] ${draft}`)
  await expect(preview.getByRole('button', { name: '确认发送' })).toBeVisible()

  // 桩确实被主进程以正确的 target_lang/原文调用过
  expect(stub.hits.some((h) => h.target_lang === 'en' && h.text === draft)).toBeTruthy()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-80-outbound-preview.png` })
  await app.close()
  await new Promise<void>((r) => stub.server.close(() => r()))
})
