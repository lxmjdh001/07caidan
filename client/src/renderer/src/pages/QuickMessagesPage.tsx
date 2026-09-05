import { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  FolderOpen,
  MessageSquareText,
  PencilLine,
  Plus,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { QuickReply } from '@shared/settings'
import { useI18n } from '../i18n'

interface Props {
  quickReplies: QuickReply[]
  onSave: (quickReplies: QuickReply[]) => Promise<void>
}

interface EditorState {
  mode: 'create' | 'edit'
  id?: string
  title: string
  text: string
  category: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function newReplyId(): string {
  return typeof crypto.randomUUID === 'function'
    ? `reply-${crypto.randomUUID()}`
    : `reply-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function QuickMessagesPage({ quickReplies, onSave }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const categories = useMemo(
    () => Array.from(new Set(quickReplies.map((reply) => reply.category?.trim()).filter((value): value is string => Boolean(value)))).sort((a, b) => a.localeCompare(b)),
    [quickReplies]
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return quickReplies.filter((reply) => {
      if (categoryFilter !== 'all' && (reply.category?.trim() || '') !== categoryFilter) return false
      if (!needle) return true
      return `${reply.title}\n${reply.text}\n${reply.category ?? ''}`.toLocaleLowerCase().includes(needle)
    })
  }, [categoryFilter, query, quickReplies])

  const persist = async (next: QuickReply[]): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      await onSave(next)
      return true
    } catch (saveError) {
      setError(errorText(saveError))
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveEditor = async (): Promise<void> => {
    if (!editor || busy) return
    const text = editor.text.trim()
    if (!text) {
      setError('请填写快捷消息内容。')
      return
    }
    const title = editor.title.trim() || text.slice(0, 40)
    const category = editor.category.trim()
    const reply: QuickReply = {
      id: editor.id ?? newReplyId(),
      title: title.slice(0, 80),
      text: text.slice(0, 4000),
      ...(category ? { category: category.slice(0, 50) } : {})
    }
    const next = editor.mode === 'edit'
      ? quickReplies.map((item) => item.id === reply.id ? reply : item)
      : [...quickReplies, reply]
    if (await persist(next)) setEditor(null)
  }

  const remove = async (reply: QuickReply): Promise<void> => {
    if (busy || !window.confirm(`确定删除快捷消息“${reply.title || reply.text.slice(0, 20)}”？`)) return
    await persist(quickReplies.filter((item) => item.id !== reply.id))
  }

  const move = async (reply: QuickReply, offset: -1 | 1): Promise<void> => {
    if (busy) return
    const index = quickReplies.findIndex((item) => item.id === reply.id)
    const target = index + offset
    if (index < 0 || target < 0 || target >= quickReplies.length) return
    const next = [...quickReplies]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    await persist(next)
  }

  return (
    <div className="page quick-messages-page">
      <header className="page-header quick-messages-header">
        <div>
          <div className="page-kicker"><MessageSquareText size={17} /> 效率工具</div>
          <h1>{t('management.quickMessages')}</h1>
          <p>{t('management.quickMessagesDesc')}，聊天时点击快捷回复即可填入。</p>
        </div>
        <div className="quick-messages-summary" aria-label="快捷消息概览">
          <div><strong>{quickReplies.length}</strong><span>消息总数</span></div>
          <div><strong>{categories.length}</strong><span>分组数量</span></div>
        </div>
      </header>

      <div className="page-body quick-messages-body">
        <section className="quick-messages-panel">
          <div className="quick-messages-toolbar">
            <label className="quick-messages-search">
              <Search size={16} />
              <input value={query} placeholder="搜索名称、内容或分组" onChange={(event) => setQuery(event.target.value)} />
              {query && <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={14} /></button>}
            </label>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="all">全部分组</option>
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
            <span className="quick-messages-count">显示 {filtered.length} / {quickReplies.length}</span>
            <button
              type="button"
              className="primary-btn quick-message-add"
              onClick={() => { setError(''); setEditor({ mode: 'create', title: '', text: '', category: '' }) }}
            >
              <Plus size={16} /> 新增快捷消息
            </button>
          </div>

          {error && !editor && <div className="quick-messages-error" role="alert"><CircleAlert size={15} /> {error}</div>}

          <div className="quick-messages-table-scroll">
            <table className="quick-messages-table">
              <thead><tr><th>顺序</th><th>名称</th><th>分组</th><th>消息内容</th><th>操作</th></tr></thead>
              <tbody>
                {filtered.map((reply) => {
                  const index = quickReplies.findIndex((item) => item.id === reply.id)
                  return (
                    <tr key={reply.id}>
                      <td><span className="quick-message-sequence">{String(index + 1).padStart(2, '0')}</span></td>
                      <td><strong className="quick-message-title">{reply.title || reply.text.slice(0, 30)}</strong></td>
                      <td>{reply.category ? <span className="quick-message-category">{reply.category}</span> : <span className="quick-message-category is-empty">未分组</span>}</td>
                      <td><span className="quick-message-preview" title={reply.text}>{reply.text}</span></td>
                      <td>
                        <div className="quick-message-actions">
                          <button type="button" title="上移" disabled={busy || index === 0} onClick={() => void move(reply, -1)}><ArrowUp size={14} /></button>
                          <button type="button" title="下移" disabled={busy || index === quickReplies.length - 1} onClick={() => void move(reply, 1)}><ArrowDown size={14} /></button>
                          <button type="button" disabled={busy} onClick={() => { setError(''); setEditor({ mode: 'edit', id: reply.id, title: reply.title, text: reply.text, category: reply.category ?? '' }) }}><PencilLine size={14} /> 编辑</button>
                          <button type="button" className="is-danger" title="删除" disabled={busy} onClick={() => void remove(reply)}><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {quickReplies.length === 0 && (
                  <tr className="quick-messages-empty-row"><td colSpan={5}>
                    <div className="quick-messages-empty">
                      <MessageSquareText size={32} />
                      <strong>还没有快捷消息</strong>
                      <span>创建常用回复后，可在所有平台的聊天输入框直接使用。</span>
                      <button type="button" className="primary-btn" onClick={() => setEditor({ mode: 'create', title: '', text: '', category: '' })}>新增快捷消息</button>
                    </div>
                  </td></tr>
                )}
                {quickReplies.length > 0 && filtered.length === 0 && (
                  <tr className="quick-messages-empty-row"><td colSpan={5}><div className="quick-messages-filter-empty"><Search size={22} />没有符合条件的快捷消息</div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {editor && (
        <div className="modal-backdrop" onClick={() => !busy && setEditor(null)}>
          <section className="quick-message-editor-modal" role="dialog" aria-modal="true" aria-labelledby="quick-message-editor-title" onClick={(event) => event.stopPropagation()}>
            <header>
              <div className="quick-message-editor-heading">
                <span><PencilLine size={19} /></span>
                <div><h2 id="quick-message-editor-title">{editor.mode === 'create' ? '新增快捷消息' : '编辑快捷消息'}</h2><p>保存后立即出现在聊天框的快捷回复列表中。</p></div>
              </div>
              <button type="button" aria-label="关闭" disabled={busy} onClick={() => setEditor(null)}><X size={18} /></button>
            </header>
            <div className="quick-message-editor-body">
              <label className="field"><span>名称</span><input maxLength={80} value={editor.title} placeholder="例如：欢迎语、物流查询" onChange={(event) => setEditor({ ...editor, title: event.target.value })} /></label>
              <label className="field"><span>分组（可选）</span><input maxLength={50} list="quick-message-category-options" value={editor.category} placeholder="例如：售前、售后" onChange={(event) => setEditor({ ...editor, category: event.target.value })} /></label>
              <datalist id="quick-message-category-options">{categories.map((category) => <option key={category} value={category} />)}</datalist>
              <label className="field quick-message-content-field"><span>消息内容</span><textarea maxLength={4000} rows={6} value={editor.text} placeholder="输入发送给客户的完整消息内容" onChange={(event) => setEditor({ ...editor, text: event.target.value })} /><small>{editor.text.length} / 4000</small></label>
              {error && <div className="quick-messages-error" role="alert"><CircleAlert size={15} /> {error}</div>}
              <div className="quick-message-editor-note"><FolderOpen size={16} /><span>快捷消息会按当前顺序显示，并通过账号配置安全同步到你的其他设备。</span></div>
            </div>
            <footer>
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => setEditor(null)}>取消</button>
              <button type="button" className="primary-btn" disabled={busy || !editor.text.trim()} onClick={() => void saveEditor()}>{busy ? '保存中…' : '保存'}</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}
