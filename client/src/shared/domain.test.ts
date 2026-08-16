import { describe, expect, it } from 'vitest'
import { channelKey, conversationId, parseConversationId, previewOf } from './domain'

describe('conversationId / parseConversationId', () => {
  it('拼接与解析互逆', () => {
    const id = conversationId('whatsapp', 'main', '123456@s.whatsapp.net')
    expect(id).toBe('whatsapp:main:123456@s.whatsapp.net')
    expect(parseConversationId(id)).toEqual({
      channel: 'whatsapp',
      accountId: 'main',
      externalChatId: '123456@s.whatsapp.net'
    })
  })

  it('externalChatId 自身含冒号时解析正确', () => {
    const id = conversationId('telegram', 'bot1', 'chat:with:colons')
    expect(parseConversationId(id).externalChatId).toBe('chat:with:colons')
  })

  it('非法 ID 抛错', () => {
    expect(() => parseConversationId('no-colons')).toThrow()
    expect(() => parseConversationId('only:one')).toThrow()
  })
})

describe('channelKey', () => {
  it('格式为 kind:accountId', () => {
    expect(channelKey('whatsapp', 'main')).toBe('whatsapp:main')
  })
})

describe('previewOf', () => {
  it('文本消息返回原文', () => {
    expect(previewOf({ type: 'text', text: 'hello' })).toBe('hello')
  })

  it('媒体消息返回类型标签，可带说明文字', () => {
    expect(previewOf({ type: 'media', mediaType: 'image' })).toBe('[图片]')
    expect(previewOf({ type: 'media', mediaType: 'document', caption: 'a.pdf' })).toBe('[文件] a.pdf')
  })

  it('不支持的消息带描述', () => {
    expect(previewOf({ type: 'unsupported', description: 'pollCreationMessage' })).toContain(
      'pollCreationMessage'
    )
  })
})
