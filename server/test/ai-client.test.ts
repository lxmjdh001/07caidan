import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AiClient, buildAsrBody, translatePrompt } from '../src/ai/ai-client.ts'

function fakeFetch(status: number, payload: unknown) {
  const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string | Uint8Array } }> = []
  const impl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string | Uint8Array }
  ) => {
    calls.push({ url, init })
    return { ok: status < 400, status, json: async () => payload }
  }
  return { impl, calls }
}

describe('AiClient.chat', () => {
  test('成功：返回文本与用量', async () => {
    const { impl, calls } = fakeFetch(200, {
      choices: [{ message: { content: '你好' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    })
    const client = new AiClient(impl)
    const r = await client.chat(
      { type: 'openai', apiKey: 'sk-x' },
      { model: 'm', messages: [{ role: 'user', content: 'hello' }] }
    )
    assert.equal(r.ok, true)
    assert.equal(r.text, '你好')
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5 })
    assert.equal(calls[0]!.url, 'https://api.openai.com/v1/chat/completions')
  })

  test('供应商报错：提取人话，不抛异常', async () => {
    const { impl } = fakeFetch(401, { error: { message: 'Invalid API key' } })
    const r = await new AiClient(impl).chat(
      { type: 'openai', apiKey: 'bad' },
      { model: 'm', messages: [{ role: 'user', content: 'x' }] }
    )
    assert.equal(r.ok, false)
    assert.equal(r.error, 'Invalid API key')
  })

  test('网络异常也不抛，返回 ok:false', async () => {
    const client = new AiClient(async () => {
      throw new Error('ECONNREFUSED')
    })
    const r = await client.chat(
      { type: 'anthropic', apiKey: 'k' },
      { model: 'm', messages: [{ role: 'user', content: 'x' }] }
    )
    assert.equal(r.ok, false)
    assert.ok(r.error?.includes('ECONNREFUSED'))
  })
})

describe('AiClient.transcribe', () => {
  test('走 /audio/transcriptions，multipart 体', async () => {
    const { impl, calls } = fakeFetch(200, { text: '识别结果' })
    const r = await new AiClient(impl).transcribe(
      { type: 'openai', apiKey: 'sk-x' },
      { modelName: 'whisper-1', audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/ogg' }
    )
    assert.equal(r.ok, true)
    assert.equal(r.text, '识别结果')
    assert.equal(calls[0]!.url, 'https://api.openai.com/v1/audio/transcriptions')
    assert.ok((calls[0]!.init.headers['content-type'] ?? '').startsWith('multipart/form-data'))
  })
})

describe('buildAsrBody', () => {
  test('包含模型字段与文件段，音频字节原样嵌入', () => {
    const audio = new Uint8Array([0xff, 0x00, 0x7f])
    const { contentType, body } = buildAsrBody({
      modelName: 'whisper-1',
      audio,
      mimeType: 'audio/ogg'
    })
    assert.ok(contentType.includes('boundary='))
    const text = Buffer.from(body).toString('latin1')
    assert.ok(text.includes('name="model"'))
    assert.ok(text.includes('whisper-1'))
    assert.ok(text.includes('filename="audio.ogg"'))
    // 二进制完整性：0xff 0x00 0x7f 连续出现
    assert.ok(Buffer.from(body).includes(Buffer.from([0xff, 0x00, 0x7f])))
  })

  test('可选语言字段', () => {
    const { body } = buildAsrBody({
      modelName: 'w',
      audio: new Uint8Array(0),
      mimeType: 'audio/ogg',
      language: 'zh'
    })
    assert.ok(Buffer.from(body).toString('latin1').includes('name="language"'))
  })
})

describe('translatePrompt', () => {
  test('只回译文的约束写进提示词', () => {
    const p = translatePrompt('Japanese')
    assert.ok(p.includes('Japanese'))
    assert.ok(p.includes('ONLY'))
  })
})
