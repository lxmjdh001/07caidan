import { describe, expect, it, vi } from 'vitest'
import { Api, type TelegramClient } from 'telegram'
import {
  isTelegramGroup,
  isUsableTelegramGroup,
  TelegramUserAdapter
} from './telegram-user-adapter'

function photo(): Api.ChatPhotoEmpty {
  return new Api.ChatPhotoEmpty()
}

function user(id: number, name: string): Api.User {
  return new Api.User({ id: id as never, firstName: name, accessHash: (id * 10) as never })
}

function chat(id: number, title: string, extra: Partial<ConstructorParameters<typeof Api.Chat>[0]> = {}): Api.Chat {
  return new Api.Chat({
    id: id as never,
    title,
    photo: photo(),
    participantsCount: 2,
    date: 1,
    version: 1,
    ...extra
  })
}

function channel(
  id: number,
  title: string,
  extra: Partial<ConstructorParameters<typeof Api.Channel>[0]> = {}
): Api.Channel {
  return new Api.Channel({
    id: id as never,
    accessHash: (id * 10) as never,
    title,
    photo: photo(),
    date: 1,
    ...extra
  })
}

function connectedAdapter(client: Pick<TelegramClient, 'getDialogs' | 'invoke'>): TelegramUserAdapter {
  const adapter = new TelegramUserAdapter({
    accountId: 'tg-test',
    getApiCredentials: () => ({ apiId: 1, apiHash: 'hash' }),
    getSession: () => 'session',
    saveSession: async () => {},
    getProxyUrl: () => 'socks5://127.0.0.1:1080'
  })
  Object.assign(adapter, { client, status: 'connected' })
  return adapter
}

describe('Telegram 群组识别', () => {
  it('识别普通群和超级群，但不把广播频道当群组', () => {
    expect(isTelegramGroup(chat(1, '普通群'))).toBe(true)
    expect(isTelegramGroup(channel(2, '超级群', { megagroup: true }))).toBe(true)
    expect(isTelegramGroup(channel(3, '广播频道', { broadcast: true }))).toBe(false)
    expect(isTelegramGroup(user(4, '联系人'))).toBe(false)
  })

  it('过滤已退出、已停用和已迁移的旧群', () => {
    expect(isUsableTelegramGroup(chat(1, '正常群'))).toBe(true)
    expect(isUsableTelegramGroup(chat(2, '已退出', { left: true }))).toBe(false)
    expect(isUsableTelegramGroup(chat(3, '已停用', { deactivated: true }))).toBe(false)
    expect(isUsableTelegramGroup(chat(4, '已迁移', {
      migratedTo: new Api.InputChannel({ channelId: 44 as never, accessHash: 440 as never })
    }))).toBe(false)
    expect(isUsableTelegramGroup(channel(5, '已退出超级群', { megagroup: true, left: true }))).toBe(false)
  })
})

describe('Telegram 群组 API', () => {
  it('列出真实群组并排除频道', async () => {
    const dialogs = [
      { entity: chat(10, '售后群') },
      { entity: channel(20, '客户超级群', { megagroup: true }) },
      { entity: channel(30, '公告频道', { broadcast: true }) },
      { entity: user(40, '客户 A') }
    ]
    const client = {
      getDialogs: vi.fn(async () => dialogs),
      invoke: vi.fn()
    } as unknown as Pick<TelegramClient, 'getDialogs' | 'invoke'>
    const adapter = connectedAdapter(client)

    await expect(adapter.listGroups()).resolves.toEqual([
      { externalChatId: 'g10', title: '售后群', participantIds: [] },
      { externalChatId: 'g20', title: '客户超级群', participantIds: [] }
    ])
  })

  it('用已解析联系人调用 messages.createChat 并返回平台真实群 ID', async () => {
    const member = user(50, '客户 B')
    const createdGroup = chat(60, '新客户群')
    const client = {
      getDialogs: vi.fn(async () => [{ entity: member }]),
      invoke: vi.fn(async (request: unknown) => {
        expect(request).toBeInstanceOf(Api.messages.CreateChat)
        expect(request).toMatchObject({ title: '新客户群', users: [member] })
        return {
          updates: new Api.Updates({
            updates: [],
            users: [member],
            chats: [createdGroup],
            date: 1,
            seq: 1
          }),
          missingInvitees: []
        }
      })
    } as unknown as Pick<TelegramClient, 'getDialogs' | 'invoke'>
    const adapter = connectedAdapter(client)
    // 先读取 dialogs，把包含 access_hash 的成员实体放入适配器缓存。
    await adapter.listGroups()

    await expect(adapter.createGroup('  新客户群  ', ['50', '50'])).resolves.toEqual({
      externalChatId: 'g60',
      title: '新客户群',
      participantIds: ['50']
    })
    expect(client.invoke).toHaveBeenCalledTimes(1)
  })
})
