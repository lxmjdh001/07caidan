import { describe, expect, test } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

describe('parseInline', () => {
  test('粗体/斜体/代码/链接混排', () => {
    const t = parseInline('前 **粗** 中 *斜* `码` [官网](https://x.com) 尾')
    expect(t).toEqual([
      { t: 'text', v: '前 ' },
      { t: 'bold', v: '粗' },
      { t: 'text', v: ' 中 ' },
      { t: 'italic', v: '斜' },
      { t: 'text', v: ' ' },
      { t: 'code', v: '码' },
      { t: 'text', v: ' ' },
      { t: 'link', v: '官网', href: 'https://x.com' },
      { t: 'text', v: ' 尾' }
    ])
  })

  test('非 http(s) 链接不解析为链接（防 javascript: 注入）', () => {
    const t = parseInline('[x](javascript:alert(1))')
    expect(t.every((x) => x.t !== 'link')).toBe(true)
  })
})

describe('parseMarkdown', () => {
  test('标题/列表/段落分块', () => {
    const b = parseMarkdown('# 标题\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n普通段落\n第二行')
    expect(b.map((x) => x.type)).toEqual(['heading', 'list', 'list', 'paragraph'])
    expect((b[1] as { ordered: boolean }).ordered).toBe(false)
    expect((b[2] as { ordered: boolean }).ordered).toBe(true)
    expect((b[3] as { inline: Array<{ v: string }> }).inline[0]!.v).toBe('普通段落 第二行')
  })

  test('HTML 原样当文本，不产生任何标签语义', () => {
    const b = parseMarkdown('<script>alert(1)</script>')
    expect(b[0]!.type).toBe('paragraph')
    expect((b[0] as { inline: Array<{ t: string; v: string }> }).inline[0]).toEqual({
      t: 'text',
      v: '<script>alert(1)</script>'
    })
  })
})
