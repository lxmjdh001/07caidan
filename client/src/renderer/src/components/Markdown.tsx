import { parseInline, parseMarkdown, type InlineToken } from '../markdown'

/** 渲染管理员写的 Markdown 文案（套餐描述等）；结构化渲染，无 innerHTML */
export function Markdown({ text }: { text: string }): React.JSX.Element | null {
  if (!text.trim()) return null
  const blocks = parseMarkdown(text)
  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const H = (['h3', 'h4', 'h5'] as const)[b.level - 1]!
          return <H key={i}>{inline(b.inline)}</H>
        }
        if (b.type === 'list') {
          const items = b.items.map((it, j) => <li key={j}>{inline(it)}</li>)
          return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>
        }
        return <p key={i}>{inline(b.inline)}</p>
      })}
    </div>
  )
}

function inline(tokens: InlineToken[]): React.ReactNode[] {
  return tokens.map((tk, i) => {
    switch (tk.t) {
      case 'bold':
        return <strong key={i}>{tk.v}</strong>
      case 'italic':
        return <em key={i}>{tk.v}</em>
      case 'code':
        return <code key={i}>{tk.v}</code>
      case 'link':
        return (
          <a
            key={i}
            href={tk.href}
            onClick={(e) => {
              // 主进程 setWindowOpenHandler 会转交系统浏览器
              e.preventDefault()
              window.open(tk.href)
            }}
          >
            {tk.v}
          </a>
        )
      default:
        return <span key={i}>{tk.v}</span>
    }
  })
}

export { parseInline, parseMarkdown }
