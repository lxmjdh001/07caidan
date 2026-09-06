import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore } from '../core/settings-store'
import { AccountEnvironmentSync } from './account-environment-sync'

vi.mock('../core/device-id', () => ({ deviceId: () => 'a'.repeat(32) }))

let dir: string
let settings: SettingsStore
let service: AccountEnvironmentSync | undefined

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wzzscrm-environment-sync-'))
  settings = new SettingsStore(dir)
  await settings.init()
  await settings.update({
    sync: { ...settings.get().sync, serverUrl: 'https://server.example', token: 'client-token' }
  })
})

afterEach(async () => {
  await service?.stop()
  service = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('AccountEnvironmentSync', () => {
  it('新电脑从当前 WzzScrm 工作区恢复凭证、指纹、代理与 LINE 密钥文件', async () => {
    const lineSession = JSON.stringify({ key: 'line-e2ee-secret' })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/release')) return response({ ok: true })
      return response({
        ok: true,
        leaseId: '1'.repeat(32),
        environment: {
          accountKey: 'line:line1',
          revision: 7,
          updatedAt: 100,
          snapshot: {
            version: 1,
            account: {
              label: 'LINE 售后',
              proxyId: 'proxy1',
              proxyUrl: 'socks5://user:pass@proxy.example:1080',
              fingerprint: { id: 'FP-CLOUD', seed: 'stable-seed', deviceName: 'Wzz-1', createdAt: 1 },
              credentials: { authToken: 'line-auth-token' }
            },
            proxyAsset: {
              id: 'proxy1', proxyUrl: 'socks5://user:pass@proxy.example:1080',
              note: '韩国住宅', createdAt: 1, updatedAt: 2
            },
            files: [{ path: 'line-session.json', data: Buffer.from(lineSession).toString('base64') }]
          },
        }
      })
    }))

    service = new AccountEnvironmentSync(settings, dir, vi.fn())
    await service.acquire('line:line1')

    const account = settings.accountConfig('line:line1')
    expect(account.label).toBe('LINE 售后')
    expect(account.credentials?.authToken).toBe('line-auth-token')
    expect(account.fingerprint?.seed).toBe('stable-seed')
    expect(account.proxyUrl).toContain('proxy.example')
    expect(settings.get().proxyAssets.proxy1?.note).toBe('韩国住宅')
    expect(await readFile(join(dir, 'channels/line/sessions/line1.json'), 'utf8')).toBe(lineSession)
  })

  it('首次升级把本机 WhatsApp 多文件会话完整上传，并取得运行租约', async () => {
    const authDir = join(dir, 'channels/whatsapp/auth/wa1')
    await mkdir(authDir, { recursive: true })
    await writeFile(join(authDir, 'creds.json'), '{"registered":true}')
    await mkdir(join(authDir, 'keys'), { recursive: true })
    await writeFile(join(authDir, 'keys/session.json'), '{"key":"secret"}')
    await settings.update({
      accounts: {
        'whatsapp:wa1': {
          label: 'WhatsApp 主号',
          credentials: { registered: 'true' },
          fingerprint: { id: 'FP-LOCAL', seed: 'seed', deviceName: 'Wzz', createdAt: 1 }
        }
      }
    })

    const calls: Array<{ url: string; method?: string; body?: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string | undefined })
      if (url.endsWith('/lease')) return response({ ok: true, leaseId: '2'.repeat(32) })
      if (init?.method === 'PUT') {
        return response({ environment: { revision: 1 } })
      }
      return response({ ok: true })
    }))

    service = new AccountEnvironmentSync(settings, dir, vi.fn())
    await service.acquire('whatsapp:wa1')

    expect(service.isUsable('whatsapp:wa1')).toBe(true)
    const put = calls.find((call) => call.method === 'PUT')
    const sent = JSON.parse(put?.body ?? '{}')
    const paths = sent.snapshot.files.map((file: { path: string }) => file.path).sort()
    expect(paths).toEqual([
      'whatsapp-auth/creds.json',
      'whatsapp-auth/keys/session.json'
    ])
    expect(JSON.stringify(sent.snapshot)).toContain('WhatsApp 主号')
    expect(JSON.stringify(sent.snapshot)).toContain('registered')
  })

  it('另一台电脑接管后，心跳失败会立即让旧电脑停止该平台连接', async () => {
    vi.useFakeTimers()
    let heartbeat = false
    const onLeaseLost = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/lease')) {
        return response({
          ok: true,
          leaseId: '3'.repeat(32),
          environment: { accountKey: 'telegram:tg1', revision: 0, snapshot: {}, updatedAt: 1 }
        })
      }
      if (url.endsWith('/heartbeat')) {
        heartbeat = true
        return response({ error: 'lease_lost' }, false, 409)
      }
      if (init?.method === 'PUT') return response({ environment: { revision: 1 } })
      return response({ ok: true })
    }))

    await settings.update({ accounts: { 'telegram:tg1': { credentials: { session: 'tg-session' } } } })
    service = new AccountEnvironmentSync(settings, dir, onLeaseLost)
    await service.acquire('telegram:tg1')
    await vi.advanceTimersByTimeAsync(20_000)

    expect(heartbeat).toBe(true)
    expect(onLeaseLost).toHaveBeenCalledWith('telegram:tg1', '账号环境已在另一台电脑接管')
    expect(service.isUsable('telegram:tg1')).toBe(false)
  })
})
