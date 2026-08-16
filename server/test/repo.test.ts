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

  test('相同 externalId 幂等去重，重复上传不增加消息', () => {
    repo.ingest('t1', payload({ messages: [msg({ externalId: 'DUP', text: 'a' })] }))
    const r = repo.ingest('t1', payload({ messages: [msg({ externalId: 'DUP', text: 'a' })] }))
    assert.equal(r.messages, 0)
    assert.equal(repo.listMessages('t1', 'whatsapp:main:42@lid').length, 1)
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

  test('媒体登记与去重探测', () => {
    assert.equal(repo.hasMedia('t1', 'a.jpg'), false)
    repo.recordMedia('t1', 'a.jpg', 'image/jpeg', '/tmp/a.jpg', 100)
    assert.equal(repo.hasMedia('t1', 'a.jpg'), true)
  })
})
