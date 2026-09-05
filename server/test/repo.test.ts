import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { openDb } from '../src/db.ts'
import { Repo } from '../src/repo.ts'
import type { SyncMessage, SyncPayload } from '../src/types.ts'

let dir: string
let repo: Repo

function msg(o: Partial<SyncMessage> = {}): SyncMessage {
  return {
    externalId: Math.random().toString(36).slice(2),
    conversationId: 'whatsapp:main:42@lid',
    channel: 'whatsapp',
    accountId: 'main',
    direction: 'in',
    bodyType: 'text',
    text: 'hello',
    timestamp: 1000,
    ...o
  }
}

function payload(o: Partial<SyncPayload> = {}): SyncPayload {
  return {
    conversations: [
      {
        id: 'whatsapp:main:42@lid',
        channel: 'whatsapp',
        accountId: 'main',
        contactId: 'wa:+17759276114',
        title: '+17759276114',
        isGroup: false,
        lastMessageAt: 1000
      }
    ],
    messages: [],
    ...o
  }
}

describe('Repo', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-srv-'))
  })
  after(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    const db = openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`))
    repo = new Repo(db)
  })

  test('ingest 写入会话与消息', () => {
    const r = repo.ingest('t1', payload({ messages: [msg({ externalId: 'M1' })] }))
    assert.equal(r.conversations, 1)
    assert.equal(r.messages, 1)
    assert.equal(repo.listConversations('t1').length, 1)
    assert.equal(repo.listMessages('t1', 'whatsapp:main:42@lid').length, 1)
  })

  test('公开账号 ID 写入并随会话读取', () => {
    repo.ingest('t1', payload({
      conversations: [{
        id: 'line:main:u123',
        channel: 'line',
        accountId: 'main',
        title: 'LINE',
        publicId: '@line',
        isGroup: false,
        lastMessageAt: 1000
      }]
    }))
    assert.equal(repo.listConversations('t1')[0]?.publicId, '@line')
  })

  test('相同 externalId 幂等去重，重复上传不增加消息', () => {
    repo.ingest('t1', payload({ messages: [msg({ externalId: 'DUP', text: 'a' })] }))
    const r = repo.ingest('t1', payload({ messages: [msg({ externalId: 'DUP', text: 'a' })] }))
    assert.equal(r.messages, 0)
    assert.equal(repo.listMessages('t1', 'whatsapp:main:42@lid').length, 1)
  })

  test('服务端消息流用复合游标分页，不会漏掉同一批写入的消息', () => {
    repo.ingest('t1', payload({ messages: [msg({ externalId: 'P1' }), msg({ externalId: 'P2' })] }))
    const first = repo.pullMessages('t1', 0, '', 1)
    assert.equal(first.length, 1)
    assert.ok(first[0]!.syncUpdatedAt > 0)
    const second = repo.pullMessages('t1', first[0]!.syncUpdatedAt, first[0]!.externalId, 10)
    assert.equal(second.length, 1)
    assert.notEqual(second[0]!.externalId, first[0]!.externalId)
    const conversations = repo.conversationsForMessages('t1', [...first, ...second])
    assert.deepEqual(conversations.map((c) => c.id), ['whatsapp:main:42@lid'])
  })

  test('租户隔离：t2 看不到 t1 的数据', () => {
    repo.ingest('t1', payload({ messages: [msg({ externalId: 'M1' })] }))
    assert.equal(repo.listConversations('t2').length, 0)
    assert.equal(repo.messagesByContact('t2', 'wa:+17759276114').length, 0)
  })

  test('messagesByContact 跨会话聚合同一客户', () => {
    // 同一 contactId 出现在两个账号的会话
    repo.ingest('t1', {
      conversations: [
        { id: 'whatsapp:a:x@lid', channel: 'whatsapp', accountId: 'a', contactId: 'wa:+1', title: '+1', isGroup: false, lastMessageAt: 1 },
        { id: 'whatsapp:b:y@lid', channel: 'whatsapp', accountId: 'b', contactId: 'wa:+1', title: '+1', isGroup: false, lastMessageAt: 2 }
      ],
      messages: [
        msg({ externalId: 'A1', conversationId: 'whatsapp:a:x@lid', accountId: 'a' }),
        msg({ externalId: 'B1', conversationId: 'whatsapp:b:y@lid', accountId: 'b' })
      ]
    })
    assert.equal(repo.messagesByContact('t1', 'wa:+1').length, 2)
  })

  test('译文与 contactId 后续补传（COALESCE 不覆盖为 null）', () => {
    repo.ingest('t1', payload({ messages: [msg({ externalId: 'M1', translationText: '你好' })] }))
    // 重复上传但不带译文，不应清空已存译文
    repo.ingest('t1', payload({ messages: [msg({ externalId: 'M1' })] }))
    const stored = repo.listMessages('t1', 'whatsapp:main:42@lid')[0]
    assert.equal(stored?.translationText, '你好')
  })

  // 投放归因：leadSource 的 upsert 用 COALESCE(既有, 新值) —— 既有优先，与 contactId 的
  // COALESCE(新值, 既有) 顺序相反(那个是客户端后补身份、新值该赢)。这个非对称是刻意的：
  // 首条入站识别到来源后就锁定，客户日后带别的追踪码再来也不改写首次归因，否则工单按来源
  // 拆分的统计会被后到的会话污染。谁"顺手统一"成和 contactId 一样的顺序，这两条会红。
  function convWithSource(code?: string, via?: 'code' | 'ad'): SyncPayload {
    return payload({
      conversations: [
        {
          id: 'whatsapp:main:42@lid',
          channel: 'whatsapp',
          accountId: 'main',
          contactId: 'wa:+17759276114',
          title: 'x',
          isGroup: false,
          lastMessageAt: 1000,
          ...(code !== undefined ? { leadSourceCode: code, leadSourceVia: via } : {})
        }
      ]
    })
  }

  test('投放来源首次识别后不再被覆盖（COALESCE 保留既有归因）', () => {
    repo.ingest('t1', convWithSource('ad_A', 'code')) // 首条带来源 A
    repo.ingest('t1', convWithSource('ad_B', 'ad')) // 客户再来、带了不同来源 B —— 不得改写
    let c = repo.listConversations('t1')[0]
    assert.equal(c?.leadSourceCode, 'ad_A', '不同来源二次同步不得覆盖首次归因')
    assert.equal(c?.leadSourceVia, 'code')
    repo.ingest('t1', convWithSource(undefined)) // 再来一条完全不带来源
    c = repo.listConversations('t1')[0]
    assert.equal(c?.leadSourceCode, 'ad_A', '空来源同步不得把已归因清成 null')
  })

  test('投放来源可后补：首次无来源、后续识别到即写入（一次性）', () => {
    repo.ingest('t1', convWithSource(undefined)) // 首次没识别到来源
    assert.equal(repo.listConversations('t1')[0]?.leadSourceCode, undefined)
    repo.ingest('t1', convWithSource('ad_X', 'code')) // 后续识别到 → 从 null 补上
    assert.equal(repo.listConversations('t1')[0]?.leadSourceCode, 'ad_X')
  })

  test('媒体登记与去重探测', () => {
    assert.equal(repo.hasMedia('t1', 'a.jpg'), false)
    repo.recordMedia('t1', 'a.jpg', 'image/jpeg', '/tmp/a.jpg', 100)
    assert.equal(repo.hasMedia('t1', 'a.jpg'), true)
  })
})
