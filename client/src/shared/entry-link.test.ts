import { describe, expect, it } from 'vitest'
import { parseTrackingCode } from '../main/core/lead-source'
import { entryLink, isValidCode, lineLink, tgLink, waLink } from './entry-link'

describe('isValidCode', () => {
  it('接受字母数字下划线连字符', () => {
    expect(isValidCode('fb_01-a')).toBe(true)
  })
  it('拒绝空、空格与超长', () => {
    expect(isValidCode('')).toBe(false)
    expect(isValidCode('a b')).toBe(false)
    expect(isValidCode('a'.repeat(33))).toBe(false)
  })
  it('拒绝会破坏解析格式的方括号', () => {
    expect(isValidCode('a]b')).toBe(false)
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
