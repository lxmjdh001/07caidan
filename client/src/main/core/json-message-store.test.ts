import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UnifiedMessage } from '@shared/domain'
import { JsonMessageStore } from './json-message-store'

let dir: string
let store: JsonMessageStore

function msg(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: Math.random().toString(36).slice(2),
    externalId: undefined,
    channel: 'whatsapp',
    accountId: 'main',
    conversationId: 'whatsapp:main:123@s.whatsapp.net',
    direction: 'in',
    authorName: 'Alice',
    body: { type: 'text', text: 'hello' },
    timestamp: 1_000,
    status: 'delivered',
    ...overrides
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnichat-store-'))
  store = new JsonMessageStore(dir)
  await store.init()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('init 容错与数据安全', () => {
  async function withStore(fileContent: string | null): Promise<{ dir: string; store: JsonMessageStore }> {
    const d = await mkdtemp(join(tmpdir(), 'omnichat-store-fault-'))
    if (fileContent !== null) await writeFile(join(d, 'store.json'), fileContent, 'utf8')
    const s = new JsonMessageStore(d)
    await s.init() // 不得抛
    return { dir: d, store: s }
  }

  it('无法识别的版本 → 忽略旧数据、回落空库、不崩', async () => {
    // 未来版本或旧格式：version!==1 一律不加载，避免按错结构读脏数据
    const { dir, store: s } = await withStore(
      JSON.stringify({ version: 2, conversations: { x: { id: 'x' } }, messages: {} })
    )
    expect(await s.listConversations()).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  it('损坏 JSON → 回落空库、不崩、之后仍可正常记录', async () => {
    const { dir, store: s } = await withStore('{ 这不是合法 JSON')
    expect(await s.listConversations()).toEqual([])
    const { conversation } = await s.recordMessage(msg())
    expect(conversation.id).toBe('whatsapp:main:123@s.whatsapp.net')
    await rm(dir, { recursive: true, force: true })
  })

  it('损坏文件在 init 时不被覆盖（防瞬时读错毁掉旧库，直到下次写入）', async () => {
    const bad = '{ 损坏但可能可救的旧数据'
    const { dir, store: s } = await withStore(bad)
    // init 只读不写：损坏文件应原样保留（不因一次读失败就清空用户历史）
    expect(await readFile(join(dir, 'store.json'), 'utf8')).toBe(bad)
    void s
    await rm(dir, { recursive: true, force: true })
  })
})

describe('JsonMessageStore', () => {
  it('记录消息时自动建会话，标题取入站消息的 authorName', async () => {
    const { conversation, duplicated } = await store.recordMessage(msg())
    expect(duplicated).toBe(false)
    expect(conversation.title).toBe('Alice')
    expect(conversation.externalChatId).toBe('123@s.whatsapp.net')
    expect(conversation.lastMessagePreview).toBe('hello')
  })

  it('入站消息按选项累计未读，markRead 清零', async () => {
    await store.recordMessage(msg(), { incrementUnread: true })
    await store.recordMessage(msg({ timestamp: 2_000 }), { incrementUnread: true })
    let convs = await store.listConversations()
    expect(convs[0]?.unreadCount).toBe(2)

    await store.markRead('whatsapp:main:123@s.whatsapp.net')
    convs = await store.listConversations()
    expect(convs[0]?.unreadCount).toBe(0)
  })

  it('同 externalId 的重复投递被去重', async () => {
    await store.recordMessage(msg({ externalId: 'X1' }))
    const second = await store.recordMessage(msg({ externalId: 'X1', id: 'other-internal-id' }))
    expect(second.duplicated).toBe(true)
    expect(await store.listMessages('whatsapp:main:123@s.whatsapp.net')).toHaveLength(1)
  })

  it('无 externalId 的消息不参与去重', async () => {
    await store.recordMessage(msg())
    await store.recordMessage(msg())
    expect(await store.listMessages('whatsapp:main:123@s.whatsapp.net')).toHaveLength(2)
  })

  it('会话按最后消息时间倒序', async () => {
    await store.recordMessage(msg({ conversationId: 'whatsapp:main:a@s.whatsapp.net', timestamp: 100 }))
    await store.recordMessage(msg({ conversationId: 'whatsapp:main:b@s.whatsapp.net', timestamp: 200 }))
    const convs = await store.listConversations()
    expect(convs.map((c) => c.externalChatId)).toEqual(['b@s.whatsapp.net', 'a@s.whatsapp.net'])
  })

  it('置顶会话优先显示并持久化，取消置顶后恢复时间排序', async () => {
    await store.recordMessage(msg({ conversationId: 'whatsapp:main:a@s.whatsapp.net', timestamp: 100 }))
    await store.recordMessage(msg({ conversationId: 'whatsapp:main:b@s.whatsapp.net', timestamp: 200 }))

    await store.patchConversation({ id: 'whatsapp:main:a@s.whatsapp.net', pinned: true })
    let convs = await store.listConversations()
    expect(convs.map((c) => c.externalChatId)).toEqual(['a@s.whatsapp.net', 'b@s.whatsapp.net'])
    expect(convs[0]?.pinned).toBe(true)

    await store.flush()
    const reloaded = new JsonMessageStore(dir)
    await reloaded.init()
    convs = await reloaded.listConversations()
    expect(convs[0]?.pinned).toBe(true)

    await reloaded.patchConversation({ id: 'whatsapp:main:a@s.whatsapp.net', pinned: false })
    convs = await reloaded.listConversations()
    expect(convs.map((c) => c.externalChatId)).toEqual(['b@s.whatsapp.net', 'a@s.whatsapp.net'])
    expect(convs[1]?.pinned).toBe(false)
  })

  it('乱序到达的旧消息不覆盖会话预览', async () => {
    await store.recordMessage(msg({ timestamp: 5_000, body: { type: 'text', text: 'newest' } }))
    await store.recordMessage(msg({ timestamp: 1_000, body: { type: 'text', text: 'old' } }))
    const convs = await store.listConversations()
    expect(convs[0]?.lastMessagePreview).toBe('newest')
  })

  it('patchConversation 修正标题；listMessages 支持 limit', async () => {
    await store.recordMessage(msg())
    const conv = await store.patchConversation({
      id: 'whatsapp:main:123@s.whatsapp.net',
      title: '客户小王'
    })
    expect(conv?.title).toBe('客户小王')

    for (let i = 0; i < 10; i++) await store.recordMessage(msg({ timestamp: 2_000 + i }))
    const recent = await store.listMessages('whatsapp:main:123@s.whatsapp.net', 5)
    expect(recent).toHaveLength(5)
    expect(recent[4]?.timestamp).toBe(2_009)
  })

  it('patchConversation 落库 leadSource 与 autoReply（曾被漏掉）', async () => {
    await store.recordMessage(msg())
    const id = 'whatsapp:main:123@s.whatsapp.net'
    const conv = await store.patchConversation({
      id,
      leadSource: { code: 'promo1', via: 'code' },
      autoReply: true
    })
    expect(conv?.leadSource?.code).toBe('promo1')
    expect(conv?.autoReply).toBe(true)
    // 读回也在
    const got = await store.getConversation(id)
    expect(got?.leadSource?.code).toBe('promo1')
    expect(got?.autoReply).toBe(true)
  })

  it('静音和客户备注会持久化', async () => {
    await store.recordMessage(msg())
    const id = 'whatsapp:main:123@s.whatsapp.net'
    await store.patchConversation({ id, muted: true, customerNote: '重点客户' })
    await store.flush()
    const reloaded = new JsonMessageStore(dir)
    await reloaded.init()
    expect(await reloaded.getConversation(id)).toMatchObject({ muted: true, customerNote: '重点客户' })
  })

  it('清空聊天保留会话，删除聊天同时移除会话和消息', async () => {
    const id = 'whatsapp:main:123@s.whatsapp.net'
    await store.recordMessage(msg(), { incrementUnread: true })
    await store.clearConversation(id)
    expect(await store.getConversation(id)).toMatchObject({ unreadCount: 0, lastMessagePreview: '' })
    expect(await store.listMessages(id)).toEqual([])

    await store.recordMessage(msg({ id: 'new' }))
    await store.deleteConversation(id)
    expect(await store.getConversation(id)).toBeUndefined()
    expect(await store.listMessages(id)).toEqual([])
  })

  it('可将来源账号客户会话和消息复制到目标账号，来源数据保留', async () => {
    const sourceId = 'whatsapp:old:123@s.whatsapp.net'
    await store.recordMessage(msg({ conversationId: sourceId, accountId: 'old', externalId: 'old-1' }), { incrementUnread: true })
    await store.patchConversation({ id: sourceId, contactId: 'wa:+8613800138000', title: '客户A' })
    const result = await store.inheritAccountConversations('whatsapp:old', 'whatsapp:new')
    expect(result).toEqual({ conversations: 1, messages: 1 })
    expect(await store.getConversation(sourceId)).toBeDefined()
    const targetId = 'whatsapp:new:123@s.whatsapp.net'
    expect(await store.getConversation(targetId)).toMatchObject({ accountId: 'new', contactId: 'wa:+8613800138000', title: '客户A' })
    expect(await store.listMessages(targetId)).toHaveLength(1)
    expect((await store.listMessages(targetId))[0]?.conversationId).toBe(targetId)
  })

  it('updateMessage 按 id 替换（媒体下载完成场景），不存在返回 false', async () => {
    const original = msg({ body: { type: 'media', mediaType: 'image' } })
    await store.recordMessage(original)

    const updated = {
      ...original,
      body: { type: 'media' as const, mediaType: 'image' as const, mediaId: 'abc.jpg' }
    }
    expect(await store.updateMessage(updated)).toBe(true)
    const list = await store.listMessages(original.conversationId)
    expect(list[0]?.body).toMatchObject({ mediaId: 'abc.jpg' })

    expect(await store.updateMessage(msg({ id: 'ghost' }))).toBe(false)
    expect(
      await store.updateMessage(msg({ conversationId: 'whatsapp:main:nope@s.whatsapp.net' }))
    ).toBe(false)
  })

  it('patch 不存在的会话返回 undefined', async () => {
    expect(await store.patchConversation({ id: 'whatsapp:main:none', title: 'x' })).toBeUndefined()
  })

  it('flush 后重新加载数据仍在（持久化）', async () => {
    await store.recordMessage(msg({ externalId: 'P1' }), { incrementUnread: true })
    await store.flush()

    const reloaded = new JsonMessageStore(dir)
    await reloaded.init()
    const convs = await reloaded.listConversations()
    expect(convs).toHaveLength(1)
    expect(convs[0]?.unreadCount).toBe(1)
    expect(await reloaded.listMessages('whatsapp:main:123@s.whatsapp.net')).toHaveLength(1)
  })
})
