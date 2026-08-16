import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonContactStore } from './contact-store'

let dir: string
let store: JsonContactStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnichat-contacts-'))
  store = new JsonContactStore(dir)
  await store.init()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('JsonContactStore', () => {
  it('首次登记：无其他会话', async () => {
    const r = await store.record('wa:+17759276114', 'whatsapp:acc1:x@lid', 'Alice')
    expect(r.otherConversations).toEqual([])
    expect(store.get('wa:+17759276114')?.names).toEqual(['Alice'])
  })

  it('同一客户出现在第二个账号的会话 → 返回此前会话（跨账号识别）', async () => {
    await store.record('wa:+17759276114', 'whatsapp:acc1:x@lid')
    const r = await store.record('wa:+17759276114', 'whatsapp:acc2:y@lid')
    expect(r.otherConversations).toEqual(['whatsapp:acc1:x@lid'])
  })

  it('同一会话重复登记不产生重复记录', async () => {
    await store.record('wa:+1', 'conv1')
    const r = await store.record('wa:+1', 'conv1')
    expect(r.otherConversations).toEqual([])
    expect(store.get('wa:+1')?.conversationIds).toEqual(['conv1'])
  })

  it('昵称历史去重记录，"+号码"式占位标题不入名称历史', async () => {
    await store.record('wa:+1', 'conv1', 'Alice')
    await store.record('wa:+1', 'conv1', 'Alice')
    await store.record('wa:+1', 'conv1', 'Alice新名字')
    await store.record('wa:+1', 'conv1', '+17759276114')
    expect(store.get('wa:+1')?.names).toEqual(['Alice', 'Alice新名字'])
  })

  it('持久化：重新加载后数据仍在', async () => {
    await store.record('wa:+1', 'conv1', 'Alice')
    const reloaded = new JsonContactStore(dir)
    await reloaded.init()
    expect(reloaded.get('wa:+1')?.conversationIds).toEqual(['conv1'])
  })
})
