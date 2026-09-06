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
const API = 'http://127.0.0.1:8798'

// 红线：配置云同步只搬非敏感偏好白名单，绝不上传翻译引擎 apiKey / 代理 / 账号凭证。
// pickSyncable 有单测，但端到端「客户端上传的 blob 确实无密钥」此前无 e2e。
test('客户端配置同步：只同步偏好，密钥/apiKey 绝不上云', async () => {
  const SECRET_KEY = 'SUPERSECRETKEY123abc'
  const LLM_SECRET = 'LLMSECRET456def'
  const SECRET_HOST = 'secret-host.internal'
  mkdirSync(USER_DATA, { recursive: true })
  // 本地埋入含密钥的翻译配置
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({
    locale: 'zh-CN',
    translation: {
      engine: 'custom-http',
      outboundEnabled: true,
      custom: { url: `http://${SECRET_HOST}/t`, apiKey: SECRET_KEY },
      llm: { baseUrl: 'https://api.x/v1', apiKey: LLM_SECRET, model: 'gpt' }
    }
  }), 'utf8')

  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)

  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-nosec-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })
  await win.waitForTimeout(1000)
  const gotIt = win.getByRole('button', { name: '我知道了' })
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

  // 改主题深色 + 保存 → 触发一次配置推送（连同翻译白名单字段）
  await win.getByTestId('client-nav-trigger').click()
  await win.getByTestId('client-nav-settings').click()
  await win.locator('label').filter({ hasText: '深色' }).locator('input[type="radio"]').check()
  await win.getByRole('button', { name: '保存', exact: true }).click()

  await win.waitForTimeout(300)
  await win.screenshot({ path: `${SHOT_DIR}/client-101-sync-no-secrets.png` })

  // 云端 blob：偏好到位（theme=dark、translation.engine），但绝无任何密钥/内网地址
  await expect(async () => {
    const cfg = (await fetch(`${API}/api/client/settings`, { headers: { authorization: `Bearer ${reg.token}` } })
      .then((r) => r.json())) as { blob?: { theme?: string; translation?: { engine?: string } } }
    expect(cfg.blob?.theme).toBe('dark')
    expect(cfg.blob?.translation?.engine).toBe('custom-http')
    const raw = JSON.stringify(cfg.blob ?? {})
    expect(raw).not.toContain(SECRET_KEY)
    expect(raw).not.toContain(LLM_SECRET)
    expect(raw).not.toContain(SECRET_HOST)
    expect(raw).not.toContain('apiKey')
  }).toPass({ timeout: 15_000 })

  await app.close()
})
