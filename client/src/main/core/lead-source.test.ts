import { describe, expect, it } from 'vitest'
import {
  detectLeadSource,
  fromAdReply,
  lineLink,
  parseTrackingCode,
  tgLink,
  waLink
} from './lead-source'

describe('parseTrackingCode', () => {
  it('识别方括号格式并归一化为小写', () => {
    expect(parseTrackingCode('你好，我想了解一下 [ref:FB_A12]')).toBe('fb_a12')
  })
  it('识别井号格式', () => {
    expect(parseTrackingCode('Hi #ref-tiktok01 想问下')).toBe('tiktok01')
  })
  it('容忍方括号内的空格', () => {
    expect(parseTrackingCode('[ref: ig-9 ]')).toBe('ig-9')
  })
  it('没有追踪码时返回空', () => {
    expect(parseTrackingCode('你好')).toBeUndefined()
    expect(parseTrackingCode(undefined)).toBeUndefined()
  })
  it('不把普通方括号内容误认成追踪码', () => {
    expect(parseTrackingCode('[图片]')).toBeUndefined()
  })
  it('超长内容不匹配，避免把整段话吞进来', () => {
    expect(parseTrackingCode(`[ref:${'a'.repeat(40)}]`)).toBeUndefined()
  })
})

describe('fromAdReply（Click-to-WhatsApp）', () => {
  it('优先用广告 id 作为分组标识', () => {
    const s = fromAdReply({ sourceId: 'AD-77', ctwaClid: 'clid123', sourceUrl: 'https://x.com/a' })
    expect(s).toMatchObject({ code: 'ad-77', via: 'ad', clickId: 'clid123' })
  })
  it('没有广告 id 时退到点击 id', () => {
    expect(fromAdReply({ ctwaClid: 'clid123' })?.code).toBe('clid123')
  })
  it('空上下文返回空', () => {
    expect(fromAdReply(undefined)).toBeUndefined()
    expect(fromAdReply({})).toBeUndefined()
  })
})

describe('detectLeadSource', () => {
  it('广告上下文优先于文案追踪码（客户可能改掉预填文字）', () => {
    const s = detectLeadSource('你好 [ref:manual]', { sourceId: 'AD-77' })
    expect(s).toMatchObject({ code: 'ad-77', via: 'ad' })
  })
  it('没有广告上下文时用文案追踪码', () => {
    expect(detectLeadSource('你好 [ref:manual]')).toMatchObject({ code: 'manual', via: 'code' })
  })
  it('两者都没有则不归因', () => {
    expect(detectLeadSource('你好')).toBeUndefined()
  })
})

describe('入口链接生成', () => {
  it('WhatsApp：号码只保留数字，追踪码进预填文案', () => {
    const url = waLink('+86 138 0013 8000', 'fb01')
    expect(url.startsWith('https://wa.me/8613800138000?text=')).toBe(true)
    expect(decodeURIComponent(url)).toContain('[ref:fb01]')
  })
  it('Telegram：去掉 @，用 ?text= 而不是 ?start=（普通账号没有 start）', () => {
    const url = tgLink('@myshop', 'tg9')
    expect(url.startsWith('https://t.me/myshop?text=')).toBe(true)
    expect(url).not.toContain('start=')
  })
  it('LINE：自动补 @ 前缀', () => {
    expect(lineLink('myoa', 'l1')).toContain('%40myoa')
  })
  it('生成的链接能被自己解析回来（闭环）', () => {
    for (const url of [waLink('+8613800138000', 'x1'), tgLink('shop', 'x1'), lineLink('@oa', 'x1')]) {
      const text = decodeURIComponent(url.split(/[?/]\??/).pop() ?? '')
      expect(parseTrackingCode(text)).toBe('x1')
    }
  })
})
