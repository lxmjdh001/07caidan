import { describe, expect, it, vi } from 'vitest'
import type { UnifiedMessage } from '@shared/domain'
import type { TranslationConfig } from '@shared/settings'
import { PassthroughTranslator } from './passthrough-translator'
import { TranslationPipeline, type TranslationUsageCharge } from './pipeline'
import { createTranslatorRegistry, configurePipeline } from './plugins'
import type { Translator } from './translator'

const upperCaser: Translator = {
  name: 'upper',
  translate: async (text) => ({ text: text.toUpperCase(), sourceLang: 'en' })
}

function textMsg(text: string): UnifiedMessage {
  return {
    id: '1',
    channel: 'whatsapp',
    accountId: 'main',
    conversationId: 'whatsapp:main:1@s.whatsapp.net',
    direction: 'in',
    body: { type: 'text', text },
    timestamp: 0,
    status: 'delivered'
  }
}

function fullConfig(overrides: Partial<TranslationConfig> = {}): TranslationConfig {
  return {
    engine: 'google-free',
    inboundEnabled: true,
    outboundEnabled: true,
    confirmBeforeSend: true,
    displayLang: 'zh-CN',
    targetLangDefault: 'en',
    custom: { url: '', apiKey: '' },
    deepl: { apiKey: '' },
    googleCloud: { apiKey: '' },
    llm: { baseUrl: '', apiKey: '', model: '' },
    ...overrides
  }
}

const SETTINGS_ON = { inboundEnabled: true, outboundEnabled: false, displayLang: 'zh-CN' }

describe('TranslationPipeline.processInbound', () => {
  it('开启时附加译文并带回检测语言，原文保留', async () => {
    const p = new TranslationPipeline(upperCaser, SETTINGS_ON)
    const { message, detectedLang } = await p.processInbound(textMsg('hello'))
    expect(message.body).toEqual({ type: 'text', text: 'hello' })
    expect(message.translation).toEqual({
      text: 'HELLO',
      sourceLang: 'en',
      targetLang: 'zh-CN',
      engine: 'upper'
    })
    expect(detectedLang).toBe('en')
  })

  it('译文与原文相同（同语言）时不附加译文，但仍返回检测语言', async () => {
    const sameLang: Translator = {
      name: 'same',
      translate: async (text) => ({ text, sourceLang: 'zh-CN' })
    }
    const p = new TranslationPipeline(sameLang, SETTINGS_ON)
    const { message, detectedLang } = await p.processInbound(textMsg('你好'))
    expect(message.translation).toBeUndefined()
    expect(detectedLang).toBe('zh-CN')
  })

  it('检测语言标准化：zh→zh-CN、und/auto→undefined', async () => {
    const make = (lang?: string): Translator => ({
      name: 'x',
      translate: async (text) => ({ text: text + '!', sourceLang: lang })
    })
    const detect = async (lang?: string) =>
      (await new TranslationPipeline(make(lang), SETTINGS_ON).processInbound(textMsg('hey')))
        .detectedLang
    expect(await detect('zh')).toBe('zh-CN')
    expect(await detect('EN')).toBe('en')
    expect(await detect('und')).toBeUndefined()
    expect(await detect(undefined)).toBeUndefined()
  })

  it('关闭 / 纯表情 / 媒体消息不翻译', async () => {
    const spy = vi.fn(upperCaser.translate)
    const off = new TranslationPipeline(
      { name: 'spy', translate: spy },
      { ...SETTINGS_ON, inboundEnabled: false }
    )
    expect((await off.processInbound(textMsg('hello'))).message.translation).toBeUndefined()

    const on = new TranslationPipeline({ name: 'spy', translate: spy }, SETTINGS_ON)
    await on.processInbound(textMsg('👍👍'))
    await on.processInbound(textMsg('12345'))
    await on.processInbound({
      ...textMsg('x'),
      body: { type: 'media', mediaType: 'image', caption: 'photo' }
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('引擎抛错时返回原消息（不阻塞收信）', async () => {
    const broken: Translator = {
      name: 'broken',
      translate: async () => {
        throw new Error('api down')
      }
    }
    const p = new TranslationPipeline(broken, SETTINGS_ON)
    const { message } = await p.processInbound(textMsg('hello'))
    expect(message.translation).toBeUndefined()
    expect(message.body).toEqual({ type: 'text', text: 'hello' })
  })
})

describe('TranslationPipeline.processOutbound', () => {
  it('开启时翻译并带回原文与引擎名', async () => {
    const p = new TranslationPipeline(upperCaser, { ...SETTINGS_ON, outboundEnabled: true })
    expect(await p.processOutbound('hi', 'en')).toEqual({
      send: 'HI',
      original: 'hi',
      engine: 'upper'
    })
  })

  it('译文与原文相同时不标记引擎（视为未翻译）', async () => {
    const same: Translator = { name: 'same', translate: async (text) => ({ text }) }
    const p = new TranslationPipeline(same, { ...SETTINGS_ON, outboundEnabled: true })
    expect(await p.processOutbound('hi', 'en')).toEqual({ send: 'hi', original: 'hi' })
  })

  it('关闭时原样发送；引擎失败时返回可见错误而不把原文当译文', async () => {
    const off = new TranslationPipeline(upperCaser, SETTINGS_ON)
    expect(await off.processOutbound('hi', 'en')).toEqual({ send: 'hi', original: 'hi' })

    const broken = new TranslationPipeline(
      { name: 'broken', translate: async () => Promise.reject(new Error('down')) },
      { ...SETTINGS_ON, outboundEnabled: true }
    )
    expect(await broken.processOutbound('hi', 'en')).toEqual({
      send: 'hi',
      original: 'hi',
      error: '翻译服务暂不可用，请稍后重试或在设置中切换翻译引擎。'
    })
  })
})

describe('TranslationPipeline Token 计费', () => {
  it('只在得到不同译文后本地估算输入输出 Token，并带平台与账号上下文', async () => {
    const p = new TranslationPipeline(upperCaser, SETTINGS_ON)
    const recorder = vi.fn<(usage: TranslationUsageCharge) => Promise<void>>(async () => undefined)
    p.setUsageRecorder(recorder)
    await p.processInbound(textMsg('A😀b'))
    expect(recorder).toHaveBeenCalledTimes(1)
    expect(recorder.mock.calls[0]?.[0]).toMatchObject({
      inputTokens: 2,
      outputTokens: 2,
      engine: 'upper',
      channel: 'whatsapp',
      accountId: 'main',
      direction: 'in'
    })
    expect(recorder.mock.calls[0]?.[0].requestId).toMatch(/^in:[0-9a-f]{64}$/)
  })

  it('同语言原样返回与服务失败都不扣 Token', async () => {
    const recorder = vi.fn<(usage: TranslationUsageCharge) => Promise<void>>(async () => undefined)
    const same = new TranslationPipeline(
      { name: 'same', translate: async (text) => ({ text }) },
      { ...SETTINGS_ON, outboundEnabled: true }
    )
    same.setUsageRecorder(recorder)
    await same.processOutbound('hello', 'en')

    const broken = new TranslationPipeline(
      { name: 'broken', translate: async () => Promise.reject(new Error('down')) },
      { ...SETTINGS_ON, outboundEnabled: true }
    )
    broken.setUsageRecorder(recorder)
    await broken.processOutbound('hello', 'en')
    expect(recorder).not.toHaveBeenCalled()
  })

  it('服务端已扣费的 AI 译文不会在客户端重复扣费', async () => {
    const p = new TranslationPipeline(
      { name: 'ai-server', translate: async () => ({ text: 'HELLO', metered: true }) },
      { ...SETTINGS_ON, outboundEnabled: true }
    )
    const recorder = vi.fn<(usage: TranslationUsageCharge) => Promise<void>>(async () => undefined)
    p.setUsageRecorder(recorder)
    expect(await p.processOutbound('你好', 'en')).toMatchObject({ send: 'HELLO' })
    expect(recorder).not.toHaveBeenCalled()
  })

  it('优先采用服务商返回的真实 Token', async () => {
    const p = new TranslationPipeline(
      { name: 'llm', translate: async () => ({ text: 'hello', usage: { inputTokens: 12, outputTokens: 3 } }) },
      { ...SETTINGS_ON, outboundEnabled: true }
    )
    const recorder = vi.fn<(usage: TranslationUsageCharge) => Promise<void>>(async () => undefined)
    p.setUsageRecorder(recorder)
    await p.processOutbound('你好', 'en')
    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 12, outputTokens: 3, engine: 'llm' }))
  })

  it('Token 不足导致扣费失败时，出站不发送未付费译文', async () => {
    const p = new TranslationPipeline(upperCaser, { ...SETTINGS_ON, outboundEnabled: true })
    p.setUsageRecorder(async () => Promise.reject(new Error('insufficient_characters')))
    expect(await p.processOutbound('hello', 'en')).toEqual({
      send: 'hello',
      original: 'hello',
      error: '翻译服务暂不可用，请稍后重试或在设置中切换翻译引擎。'
    })
  })
})

describe('createTranslatorRegistry / configurePipeline', () => {
  it('内置插件齐全（含 deepl / google-cloud / llm）', () => {
    const plugins = createTranslatorRegistry().list()
    const ids = plugins.map((p) => p.id)
    for (const id of ['google-free', 'deepl', 'google-cloud', 'llm', 'custom-http', 'off']) {
      expect(ids).toContain(id)
    }
    expect(plugins.every((p) => !/[（(].*[）)]/.test(p.displayName))).toBe(true)
  })

  it('engine=off 时强制关闭收发翻译', () => {
    const p = new TranslationPipeline(new PassthroughTranslator())
    configurePipeline(p, createTranslatorRegistry(), fullConfig({ engine: 'off', displayLang: 'ja' }))
    expect(p.getSettings()).toMatchObject({
      inboundEnabled: false,
      outboundEnabled: false,
      displayLang: 'ja'
    })
  })

  it('引擎缺少必填配置时降级为关闭而不崩溃（deepl/google-cloud/llm/custom-http）', () => {
    for (const engine of ['deepl', 'google-cloud', 'llm', 'custom-http']) {
      const p = new TranslationPipeline(new PassthroughTranslator())
      expect(() =>
        configurePipeline(p, createTranslatorRegistry(), fullConfig({ engine }))
      ).not.toThrow()
    }
  })
})
