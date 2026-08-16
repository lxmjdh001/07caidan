import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UnifiedMessage } from '@shared/domain'
import { transcribeMessage, type TranscriberDeps } from './transcriber'

let dir: string
let audioPath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-asr-'))
  audioPath = join(dir, 'v.ogg')
  writeFileSync(audioPath, Buffer.from([1, 2, 3, 4]))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function voiceMsg(over: Partial<UnifiedMessage['body'] & { id?: string }> = {}): UnifiedMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    channel: 'whatsapp',
    accountId: 'a',
    direction: 'in',
    timestamp: 0,
    status: 'delivered',
    body: {
      type: 'media',
      mediaType: 'audio',
      mediaId: 'v1',
      mimeType: 'audio/ogg',
      durationSec: 7,
      ...over
    } as UnifiedMessage['body']
  }
}

function deps(msg: UnifiedMessage, asrText = '你好'): TranscriberDeps & { saved: UnifiedMessage[] } {
  const saved: UnifiedMessage[] = []
  return {
    saved,
    getMessages: async () => [msg],
    resolveMedia: (id) => (id === 'v1' ? audioPath : undefined),
    asr: async (b) => {
      expect(b.durationSec).toBe(7)
      expect(b.audioBase64.length).toBeGreaterThan(0)
      return { text: asrText }
    },
    saveMessage: async (m) => {
      saved.push(m)
    }
  }
}

describe('transcribeMessage', () => {
  it('识别成功并把结果缓存到消息上', async () => {
    const msg = voiceMsg()
    const d = deps(msg)
    const r = await transcribeMessage(d, 'c1', 'm1')
    expect(r).toMatchObject({ ok: true, transcript: '你好', cached: false })
    const body = d.saved[0]!.body
    expect(body.type === 'media' && body.transcript).toBe('你好')
  })

  it('已有缓存直接返回，不再调 ASR（同一条语音只花一次积分）', async () => {
    const msg = voiceMsg({ transcript: '缓存结果' })
    let called = 0
    const d = deps(msg)
    d.asr = async () => {
      called++
      return { text: 'x' }
    }
    const r = await transcribeMessage(d, 'c1', 'm1')
    expect(r).toMatchObject({ ok: true, transcript: '缓存结果', cached: true })
    expect(called).toBe(0)
  })

  it('非语音消息拒绝', async () => {
    const msg = voiceMsg()
    msg.body = { type: 'text', text: 'hi' }
    const r = await transcribeMessage(deps(msg), 'c1', 'm1')
    expect(r.ok).toBe(false)
  })

  it('媒体未下载完成给出人话', async () => {
    const r = await transcribeMessage(deps(voiceMsg({ mediaId: undefined })), 'c1', 'm1')
    expect(r).toMatchObject({ ok: false, error: '语音尚未下载完成' })
  })

  it('后台报错（如积分不足）透传错误信息，不写缓存', async () => {
    const msg = voiceMsg()
    const d = deps(msg)
    d.asr = async () => {
      throw new Error('积分不足')
    }
    const r = await transcribeMessage(d, 'c1', 'm1')
    expect(r).toMatchObject({ ok: false, error: '积分不足' })
    expect(d.saved.length).toBe(0)
  })

  it('缺时长时按文件大小粗估', async () => {
    const msg = voiceMsg({ durationSec: undefined })
    const d = deps(msg)
    d.asr = async (b) => {
      expect(b.durationSec).toBeGreaterThanOrEqual(1)
      return { text: 'ok' }
    }
    const r = await transcribeMessage(d, 'c1', 'm1')
    expect(r.ok).toBe(true)
  })
})
