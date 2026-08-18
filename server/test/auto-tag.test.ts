import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { StubAnalyzer, type Analyzer, type IntentAnalysis } from '../src/analyzer.ts'
import { AutoTagger } from '../src/auto-tagger.ts'
import { openDb } from '../src/db.ts'
import { IntentRepo } from '../src/intent-repo.ts'
import { Repo } from '../src/repo.ts'
import type { StoredMessage } from '../src/types.ts'

const T = 't1'
let dir: string
let repo: Repo
let intents: IntentRepo

function seedInbound(convId: string, text: string, at: number): void {
  repo.ingest(T, {
    conversations: [
      { id: convId, channel: 'whatsapp', accountId: 'a1', contactId: convId, title: 'x', isGroup: false, lastMessageAt: at }
    ],
    messages: [
      { externalId: `${convId}:${at}`, conversationId: convId, channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text, timestamp: at }
    ]
  })
}

describe('StubAnalyzer 关键词意向', () => {
  const a = new StubAnalyzer()
  const msg = (text: string): StoredMessage[] =>
    [{ conversationId: 'c', channel: 'whatsapp', accountId: 'a1', direction: 'in', bodyType: 'text', text, timestamp: 1, externalId: 'e', status: 'delivered' } as unknown as StoredMessage]

  test('下单/价格 → high', async () => {
    assert.equal((await a.analyze(msg('这个多少钱？怎么买'))).intentLevel, 'high')
    assert.equal((await a.analyze(msg('can I order this? price?'))).intentLevel, 'high')
  })
  test('提问 → medium', async () => {
    assert.equal((await a.analyze(msg('有货吗？'))).intentLevel, 'medium')
  })
  test('一般互动 → low', async () => {
    assert.equal((await a.analyze(msg('你好'))).intentLevel, 'low')
  })
  test('只有出站/无内容 → unknown', async () => {
    assert.equal((await a.analyze([])).intentLevel, 'unknown')
  })
})

describe('IntentRepo', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-intent-'))
  })
  after(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    const db = openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`))
    repo = new Repo(db)
    intents = new IntentRepo(db)
  })

  test('put/get 往返', () => {
    const a: IntentAnalysis = { intentLevel: 'high', summary: 's', signals: ['x'], suggestedAction: 'go' }
    intents.put(T, 'c1', a, 100)
    const g = intents.get(T, 'c1')
    assert.equal(g?.level, 'high')
    assert.deepEqual(g?.signals, ['x'])
    assert.equal(g?.lastInboundAt, 100)
  })

  test('levelsFor 批量', () => {
    intents.put(T, 'c1', { intentLevel: 'high', summary: '', signals: [], suggestedAction: '' }, 1)
    intents.put(T, 'c2', { intentLevel: 'low', summary: '', signals: [], suggestedAction: '' }, 1)
    const m = intents.levelsFor(T, ['c1', 'c2', 'c3'])
    assert.equal(m.get('c1'), 'high')
    assert.equal(m.get('c2'), 'low')
    assert.equal(m.has('c3'), false)
  })

  test('needsRetag：无记录/有更新入站为真，同状态为假', () => {
    assert.equal(intents.needsRetag(T, 'c1', 100), true) // 无记录
    intents.put(T, 'c1', { intentLevel: 'low', summary: '', signals: [], suggestedAction: '' }, 100)
    assert.equal(intents.needsRetag(T, 'c1', 100), false) // 同状态
    assert.equal(intents.needsRetag(T, 'c1', 200), true) // 有更新入站
    assert.equal(intents.needsRetag(T, 'c1', 0), false) // 无入站不打
  })
})

describe('AutoTagger', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-tagger-'))
  })
  after(() => rmSync(dir, { recursive: true, force: true }))
  beforeEach(() => {
    const db = openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`))
    repo = new Repo(db)
    intents = new IntentRepo(db)
  })

  test('关闭时不打标签', async () => {
    seedInbound('c1', '多少钱', 100)
    const tagger = new AutoTagger(repo, intents, { analyzer: new StubAnalyzer(), enabled: false })
    assert.equal(await tagger.tag(T, ['c1']), 0)
    assert.equal(intents.get(T, 'c1'), null)
  })

  test('开启时按内容打标签并落库', async () => {
    seedInbound('c1', '这个多少钱怎么买', 100)
    seedInbound('c2', '你好', 100)
    const tagger = new AutoTagger(repo, intents, { analyzer: new StubAnalyzer(), enabled: true })
    assert.equal(await tagger.tag(T, ['c1', 'c2']), 2)
    assert.equal(intents.get(T, 'c1')?.level, 'high')
    assert.equal(intents.get(T, 'c2')?.level, 'low')
  })

  test('needsRetag 节流：无新入站再调不重复分析', async () => {
    seedInbound('c1', '多少钱', 100)
    let calls = 0
    const counting: Analyzer = {
      analyze: async (m) => {
        calls++
        return new StubAnalyzer().analyze(m)
      }
    }
    const tagger = new AutoTagger(repo, intents, { analyzer: counting, enabled: true })
    await tagger.tag(T, ['c1'])
    await tagger.tag(T, ['c1']) // 无新入站
    assert.equal(calls, 1)
    // 来了新入站消息 → 重新分析
    seedInbound('c1', '再问一下', 200)
    await tagger.tag(T, ['c1'])
    assert.equal(calls, 2)
  })

  test('maxPerRun 上限', async () => {
    for (let i = 0; i < 5; i++) seedInbound(`c${i}`, '多少钱', 100)
    const tagger = new AutoTagger(repo, intents, { analyzer: new StubAnalyzer(), enabled: true, maxPerRun: 2 })
    assert.equal(await tagger.tag(T, ['c0', 'c1', 'c2', 'c3', 'c4']), 2)
  })
})
