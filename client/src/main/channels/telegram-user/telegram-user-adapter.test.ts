import { describe, expect, it, vi } from 'vitest'

const telegramMock = vi.hoisted(() => ({
  clients: [] as Array<{ disconnect: () => Promise<void> }>
}))

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,test') }
}))

vi.mock('telegram/sessions/index.js', () => ({
  StringSession: class StringSession {
    save(): string {
      return ''
    }
  }
}))

vi.mock('telegram/events/index.js', () => ({
  NewMessage: class NewMessage {}
}))

vi.mock('telegram', () => {
  class User {}
  class Chat {}
  class Channel {}
  class MockTelegramClient {
    readonly session = { save: () => '' }
    private rejectLogin?: (error: Error) => void

    constructor(..._args: unknown[]) {
      telegramMock.clients.push(this)
    }

    async connect(): Promise<void> {}

    async checkAuthorization(): Promise<boolean> {
      return false
    }

    async signInUserWithQrCode(
      _credentials: unknown,
      auth: { qrCode: (value: { token: Uint8Array; expires: number }) => Promise<void> }
    ): Promise<never> {
      await auth.qrCode({ token: new Uint8Array([1, 2, 3]), expires: Date.now() + 30_000 })
      return new Promise<never>((_resolve, reject) => {
        this.rejectLogin = reject
      })
    }

    async start(auth: { phoneNumber: () => Promise<string> }): Promise<void> {
      await auth.phoneNumber()
    }

    async disconnect(): Promise<void> {
      this.rejectLogin?.(new Error('Cannot send requests while disconnected. Please reconnect.'))
    }

    addEventHandler(): void {}
  }

  return {
    TelegramClient: MockTelegramClient,
    Api: {
      User,
      Chat,
      Channel,
      auth: { LogOut: class LogOut {} }
    }
  }
})

import type { ChannelState } from '@shared/domain'
import { TelegramUserAdapter } from './telegram-user-adapter'

describe('TelegramUserAdapter 登录任务隔离', () => {
  it('切换登录方式后，旧二维码任务的断连错误不能覆盖新流程', async () => {
    telegramMock.clients.length = 0
    const adapter = new TelegramUserAdapter({
      accountId: 'test',
      getApiCredentials: () => ({ apiId: 1, apiHash: 'hash' }),
      getSession: () => undefined,
      saveSession: async () => {},
      getProxyUrl: () => 'socks5://127.0.0.1:1080'
    })
    const states: ChannelState[] = []
    adapter.on('state', (state) => states.push(state))

    const firstRun = adapter.start()
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('waiting_qr'))

    // 重复 start 不得再创建第二个 TelegramClient。
    await adapter.start()
    expect(telegramMock.clients).toHaveLength(1)

    const switchedRun = adapter.setLoginMode('phone')
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('waiting_phone'))
    await firstRun
    await Promise.resolve()

    expect(states.at(-1)?.status).toBe('waiting_phone')
    expect(states.slice(states.findLastIndex((state) => state.status === 'waiting_phone')))
      .not.toContainEqual(expect.objectContaining({ status: 'error' }))

    await adapter.stop()
    await switchedRun
  })
})
