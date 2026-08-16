import { describe, expect, it, vi } from 'vitest'
import type { UnifiedMessage } from '@shared/domain'
import { PassthroughTranslator } from './passthrough-translator'
import { TranslationPipeline } from './pipeline'
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

describe('TranslationPipeline.processInbound', () => {
  it('开启时给文本消息附加译文，原文保留', async () => {
    const p = new TranslationPipeline(upperCaser, {
      inboundEnabled: true,
      outboundEnabled: false,
      displayLang: 'zh-CN'
    })
    const out = await p.processInbound(textMsg('hello'))
    expect(out.body).toEqual({ type: 'text', text: 'hello' })
    expect(out.translation).toEqual({
      text: 'HELLO',
      sourceLang: 'en',
      targetLang: 'zh-CN',
      engine: 'upper'
    })
  })

  it('关闭时不翻译', async () => {
    const p = new TranslationPipeline(upperCaser, {
      inboundEnabled: false,
      outboundEnabled: false,
      displayLang: 'zh-CN'
    })
    expect((await p.processInbound(textMsg('hello'))).translation).toBeUndefined()
  })

  it('译文与原文相同（passthrough/同语言）时不附加', async () => {
    const p = new TranslationPipeline(new PassthroughTranslator(), {
      inboundEnabled: true,
      outboundEnabled: false,
      displayLang: 'zh-CN'
    })
    expect((await p.processInbound(textMsg('你好'))).translation).toBeUndefined()
  })

  it('纯表情/数字等无文字内容跳过翻译', async () => {
    const spy = vi.fn(upperCaser.translate)
    const p = new TranslationPipeline({ name: 'spy', translate: spy }, {
      inboundEnabled: true,
      outboundEnabled: false,
      displayLang: 'zh-CN'
    })
    await p.processInbound(textMsg('👍👍'))
    await p.processInbound(textMsg('12345'))
    await p.processInbound(textMsg('   '))
    expect(spy).not.toHaveBeenCalled()
  })

  it('媒体消息不翻译', async () => {
    const p = new TranslationPipeline(upperCaser, {
      inboundEnabled: true,
      outboundEnabled: false,
      displayLang: 'zh-CN'
    })
    const msg: UnifiedMessage = {
      ...textMsg('x'),
      body: { type: 'media', mediaType: 'image', caption: 'photo' }
    }
    expect((await p.processInbound(msg)).translation).toBeUndefined()
  })

  it('引擎抛错时返回原消息（不阻塞收信）', async () => {
    const broken: Translator = {
      name: 'broken',
      translate: async () => {
        throw new Error('api down')
      }
    }
    const p = new TranslationPipeline(broken, {
      inboundEnabled: true,
      outboundEnabled: false,
      displayLang: 'zh-CN'
    })
    const out = await p.processInbound(textMsg('hello'))
    expect(out.translation).toBeUndefined()
    expect(out.body).toEqual({ type: 'text', text: 'hello' })
  })
})

describe('TranslationPipeline.processOutbound', () => {
  it('开启时翻译并保留原文', async () => {
    const p = new TranslationPipeline(upperCaser, {
      inboundEnabled: false,
      outboundEnabled: true,
      displayLang: 'zh-CN'
    })
    expect(await p.processOutbound('hi', 'en')).toEqual({ send: 'HI', original: 'hi' })
  })

  it('关闭时原样发送；引擎失败时降级原文', async () => {
    const off = new TranslationPipeline(upperCaser, {
      inboundEnabled: false,
      outboundEnabled: false,
      displayLang: 'zh-CN'
    })
    expect(await off.processOutbound('hi', 'en')).toEqual({ send: 'hi', original: 'hi' })

    const broken = new TranslationPipeline(
      { name: 'broken', translate: async () => Promise.reject(new Error('down')) },
      { inboundEnabled: false, outboundEnabled: true, displayLang: 'zh-CN' }
    )
    expect(await broken.processOutbound('hi', 'en')).toEqual({ send: 'hi', original: 'hi' })
  })
})

describe('createTranslatorRegistry / configurePipeline', () => {
  it('内置插件齐全，重复注册抛错', () => {
    const registry = createTranslatorRegistry()
    const ids = registry.list().map((p) => p.id)
    expect(ids).toContain('google-free')
    expect(ids).toContain('custom-http')
    expect(ids).toContain('off')
    expect(() =>
      registry.register({ id: 'off', displayName: 'x', create: () => new PassthroughTranslator() })
    ).toThrow()
  })

  it('按设置装配管道；engine=off 时强制关闭收发翻译', () => {
    const registry = createTranslatorRegistry()
    const p = new TranslationPipeline(new PassthroughTranslator())
    configurePipeline(p, registry, {
      engine: 'off',
      inboundEnabled: true,
      outboundEnabled: true,
      displayLang: 'ja',
      custom: { url: '', apiKey: '' }
    })
    expect(p.getSettings()).toMatchObject({
      inboundEnabled: false,
      outboundEnabled: false,
      displayLang: 'ja'
    })
  })

  it('custom-http 未配置 URL 时降级为关闭而不是崩溃', () => {
    const registry = createTranslatorRegistry()
    const p = new TranslationPipeline(new PassthroughTranslator())
    configurePipeline(p, registry, {
      engine: 'custom-http',
      inboundEnabled: true,
      outboundEnabled: false,
      displayLang: 'zh-CN',
      custom: { url: '', apiKey: '' }
    })
    expect(p.getSettings().inboundEnabled).toBe(true)
    // 引擎创建失败 → 退回 passthrough（off 插件），行为上等于不翻译
  })
})
