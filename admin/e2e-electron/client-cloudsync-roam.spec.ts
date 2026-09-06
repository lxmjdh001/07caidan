import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOT_DIR = process.env.SHOT_DIR || join(import.meta.dirname, '..', 'e2e', 'shots')
mkdirSync(SHOT_DIR, { recursive: true })
const CLIENT_DIR = resolve(import.meta.dirname, '..', '..', 'client')
const MAIN = join(CLIENT_DIR, 'out', 'main', 'index.js')
const ELECTRON_PATH = createRequire(join(CLIENT_DIR, 'package.json'))('electron') as string
const API = 'http://127.0.0.1:8798'

function launch(userData: string): Promise<ElectronApplication> {
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ locale: 'zh-CN' }), 'utf8')
  return electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-roam-ignored')}`], env: { ...process.env, OMNI_USER_DATA: userData } })
}

// M5 配置云同步：设备 A 改主题为深色 → 推送云端 → 设备 B(新)登录同账号拉回深色
test('客户端云端漫游：主题偏好跨设备同步', async () => {
  const TAG = Date.now().toString(36).slice(-5)
  const email = `boss_${TAG}_${Math.random().toString(36).slice(2, 5)}@e2e.test`
  const reg = await fetch(`${API}/api/client/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'secret123' })
  }).then((r) => r.json() as Promise<{ token: string }>)

  const login = async (win: Awaited<ReturnType<ElectronApplication['firstWindow']>>) => {
    await win.locator('input[type="email"]').fill(email)
    await win.locator('input[type="password"]').fill('secret123')
    await win.locator('.auth-submit').click()
    await expect(win.getByTestId('client-nav-trigger')).toBeVisible({ timeout: 20_000 })
    await win.waitForTimeout(1000)
    const gotIt = win.getByRole('button', { name: '我知道了' })
    if (await gotIt.isVisible().catch(() => false)) await gotIt.click()
  }

  // 设备 A：改主题深色 + 保存（云端漫游默认开，触发推送）
  const appA = await launch(mkdtempSync(join(tmpdir(), 'omni-A-')))
  const winA = await appA.firstWindow()
  await winA.waitForLoadState('domcontentloaded')
  await login(winA)
  await winA.getByTestId('client-nav-trigger').click()
  await winA.getByTestId('client-nav-settings').click()
  await winA.locator('label').filter({ hasText: '深色' }).locator('input[type="radio"]').check()
  await winA.getByRole('button', { name: '保存', exact: true }).click()

  // 轮询云端直到主题已收到 dark（免依赖固定防抖时长）
  await expect(async () => {
    const cfg = await fetch(`${API}/api/client/settings`, { headers: { authorization: `Bearer ${reg.token}` } })
      .then((r) => r.json() as Promise<{ blob?: { theme?: string } }>)
    expect(cfg.blob?.theme).toBe('dark')
  }).toPass({ timeout: 15_000 })
  await appA.close()

  // 设备 B（全新 userData）：登录同账号 → 启动拉取云端配置 → 主题为深色
  const appB = await launch(mkdtempSync(join(tmpdir(), 'omni-B-')))
  const winB = await appB.firstWindow()
  await winB.waitForLoadState('domcontentloaded')
  await login(winB)
  await expect(winB.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 15_000 })

  await winB.waitForTimeout(300)
  await winB.screenshot({ path: `${SHOT_DIR}/client-54-cloudsync-roam.png` })
  await appB.close()
})
