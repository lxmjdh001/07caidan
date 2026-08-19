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

test('클라이언트 한국어: 팀/내비게이션이 모두 한국어(영어 폴백 없음)', async () => {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(join(USER_DATA, 'settings.json'), JSON.stringify({ locale: 'ko' }), 'utf8')
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [MAIN, `--user-data-dir=${join(tmpdir(), 'omni-ko-ignored')}`], env: { ...process.env, OMNI_USER_DATA: USER_DATA } })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  const email = `boss_${Date.now().toString(36)}@e2e.test`
  await win.locator('.auth-switch button').first().click()
  await win.locator('input[type="email"]').fill(email)
  await win.locator('input[type="password"]').fill('secret123')
  await win.locator('.auth-submit').click()
  await expect(win.locator('.rail-nav').first()).toBeVisible({ timeout: 20_000 })

  await win.locator('.rail-nav', { hasText: '팀 관리' }).click()
  await expect(win.getByRole('heading', { name: '로그인 기기' })).toBeVisible({ timeout: 10_000 })
  await expect(win.getByRole('heading', { name: '멤버' })).toBeVisible()
  await win.waitForTimeout(400)
  await win.screenshot({ path: `${SHOT_DIR}/client-09-ko-team.png` })

  await expect(win.locator('.rail-nav', { hasText: '요금제 및 잔액' })).toBeVisible()
  await expect(win.locator('.rail-nav', { hasText: '도움말 및 피드백' })).toBeVisible()
  await app.close()
})
