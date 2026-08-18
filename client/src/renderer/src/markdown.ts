/**
 * 极简 Markdown 解析（套餐描述等运营文案用）。
 *
 * 只做安全子集：标题 / 粗斜体 / 行内代码 / 无序与有序列表 / 链接 / 段落。
 * 输出结构化 token，由 React 组件渲染成元素 —— 全程不拼 HTML 字符串，
 * 天然免疫 XSS（描述是管理员写的，但防御性设计不依赖"作者可信"）。
 */

export type InlineToken =
  | { t: 'text'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string }

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; inline: InlineToken[] }
  | { type: 'paragraph'; inline: InlineToken[] }
  | { type: 'list'; ordered: boolean; items: InlineToken[][] }

const INLINE_RE = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g

export function parseInline(text: string): InlineToken[] {
  const out: InlineToken[] = []
  let last = 0
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ t: 'text', v: text.slice(last, idx) })
    if (m[2] !== undefined) out.push({ t: 'bold', v: m[2] })
    else if (m[4] !== undefined) out.push({ t: 'italic', v: m[4] })
    else if (m[6] !== undefined) out.push({ t: 'code', v: m[6] })
    else if (m[8] !== undefined) out.push({ t: 'link', v: m[8], href: m[9]! })
    last = idx + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = []
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!trimmed) {
      i++
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed)
    if (h) {
      blocks.push({
        type: 'heading',
        level: h[1]!.length as 1 | 2 | 3,
        inline: parseInline(h[2]!)
      })
      i++
      continue
    }
    if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      const ordered = /^\d/.test(trimmed)
      const items: InlineToken[][] = []
      while (i < lines.length) {
        const t = lines[i]!.trim()
        const m = ordered ? /^\d+[.)]\s+(.*)$/.exec(t) : /^[-*]\s+(.*)$/.exec(t)
        if (!m) break
        items.push(parseInline(m[1]!))
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    // 段落：连续非空行合并，单个换行视为软换行（用空格连接）
    const buf: string[] = [trimmed]
    i++
    while (i < lines.length) {
      const t = lines[i]!.trim()
      if (!t || /^(#{1,3})\s/.test(t) || /^[-*]\s/.test(t) || /^\d+[.)]\s/.test(t)) break
      buf.push(t)
      i++
    }
    blocks.push({ type: 'paragraph', inline: parseInline(buf.join(' ')) })
  }
  return blocks
}
