import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ApiClient,
  ProxyVendor,
  ProxyVendorInput,
  ProxyVendorRegion
} from '../api'

interface Props {
  client: ApiClient
}

interface EditorState extends ProxyVendorInput {
  id?: string
}

const EMPTY_VENDOR: ProxyVendorInput = {
  name: '',
  region: 'global',
  summary: '',
  purchaseUrl: '',
  logoUrl: '',
  badge: '',
  buttonLabel: '立即访问',
  enabled: true,
  recommended: false,
  sortOrder: 0
}

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || 'IP'
}

function regionName(region: ProxyVendorRegion): string {
  return region === 'china' ? '中国代理' : '全球代理'
}

function VendorLogo({ vendor }: { vendor: Pick<ProxyVendor, 'name' | 'logoUrl'> }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [vendor.logoUrl])
  return (
    <span className="proxy-vendor-admin-logo" aria-hidden>
      {vendor.logoUrl && !failed
        ? <img src={vendor.logoUrl} alt="" onError={() => setFailed(true)} />
        : initials(vendor.name)}
    </span>
  )
}

/** 客户端“全球代理 / 中国代理”卡片目录。这里只管商家资料，不接触客户的代理密钥。 */
export function ProxyVendorsView({ client }: Props): React.JSX.Element {
  const [vendors, setVendors] = useState<ProxyVendor[]>([])
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState<'all' | ProxyVendorRegion>('all')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setVendors((await client.listProxyVendors()).vendors)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return vendors.filter((vendor) => {
      if (region !== 'all' && vendor.region !== region) return false
      if (!needle) return true
      return [vendor.name, vendor.summary, vendor.badge, vendor.purchaseUrl]
        .join(' ')
        .toLocaleLowerCase()
        .includes(needle)
    })
  }, [query, region, vendors])

  const openCreate = (): void => {
    setError('')
    setEditor({ ...EMPTY_VENDOR, sortOrder: vendors.length * 10 + 10 })
  }
  const openEdit = (vendor: ProxyVendor): void => {
    setError('')
    setEditor({
      id: vendor.id,
      name: vendor.name,
      region: vendor.region,
      summary: vendor.summary,
      purchaseUrl: vendor.purchaseUrl,
      logoUrl: vendor.logoUrl,
      badge: vendor.badge,
      buttonLabel: vendor.buttonLabel,
      enabled: vendor.enabled,
      recommended: vendor.recommended,
      sortOrder: vendor.sortOrder
    })
  }

  const save = async (): Promise<void> => {
    if (!editor) return
    setBusy(editor.id || 'new')
    setError('')
    const { id, ...body } = editor
    try {
      if (id) await client.updateProxyVendor(id, body)
      else await client.createProxyVendor(body)
      setEditor(null)
      await load()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy('')
    }
  }

  const update = async (vendor: ProxyVendor, patch: Partial<ProxyVendorInput>): Promise<void> => {
    setBusy(vendor.id)
    setError('')
    try {
      await client.updateProxyVendor(vendor.id, patch)
      await load()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy('')
    }
  }

  const remove = async (vendor: ProxyVendor): Promise<void> => {
    if (!window.confirm(`确定删除“${vendor.name}”？客户端会立即不再显示。`)) return
    setBusy(vendor.id)
    setError('')
    try {
      await client.deleteProxyVendor(vendor.id)
      await load()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="view proxy-vendors-view">
      <header className="view-header proxy-vendors-header">
        <div>
          <h1>代理平台</h1>
          <p>管理客户端采购页的供应商、跳转链接、排序与上下架。</p>
        </div>
        <div className="proxy-vendors-stats">
          <span><b>{vendors.length}</b> 全部</span>
          <span><b>{vendors.filter((item) => item.enabled).length}</b> 已上架</span>
        </div>
        <button className="ghost" type="button" disabled={loading} onClick={() => void load()}>刷新</button>
        <button className="primary" type="button" onClick={openCreate}>＋ 添加平台</button>
      </header>

      <div className="view-body">
        {error && <div className="proxy-vendors-error" role="alert">{error}</div>}
        <div className="proxy-vendors-toolbar">
          <input
            value={query}
            placeholder="搜索名称、简介或链接"
            onChange={(event) => setQuery(event.target.value)}
          />
          <select value={region} onChange={(event) => setRegion(event.target.value as 'all' | ProxyVendorRegion)}>
            <option value="all">全部分类</option>
            <option value="global">全球代理</option>
            <option value="china">中国代理</option>
          </select>
          <span>显示 {filtered.length} / {vendors.length}</span>
        </div>

        <div className="proxy-vendors-table-wrap">
          <table className="users-table proxy-vendors-table">
            <thead>
              <tr>
                <th>平台</th>
                <th>分类</th>
                <th>客户端文案</th>
                <th>跳转链接</th>
                <th>排序</th>
                <th>展示状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((vendor) => (
                <tr key={vendor.id} className={vendor.enabled ? '' : 'row-off'}>
                  <td>
                    <div className="proxy-vendor-admin-name">
                      <VendorLogo vendor={vendor} />
                      <div><strong>{vendor.name}</strong>{vendor.badge && <small>{vendor.badge}</small>}</div>
                    </div>
                  </td>
                  <td><span className={`proxy-vendor-region is-${vendor.region}`}>{regionName(vendor.region)}</span></td>
                  <td className="proxy-vendor-summary" title={vendor.summary}>{vendor.summary || '—'}</td>
                  <td><a className="proxy-vendor-link" href={vendor.purchaseUrl} target="_blank" rel="noreferrer">打开链接 ↗</a></td>
                  <td className="proxy-vendor-sort">{vendor.sortOrder}</td>
                  <td>
                    <div className="proxy-vendor-state-actions">
                      <button
                        type="button"
                        className={`pill ${vendor.enabled ? 'on' : 'offp'}`}
                        disabled={busy === vendor.id}
                        onClick={() => void update(vendor, { enabled: !vendor.enabled })}
                      >{vendor.enabled ? '已上架' : '已下架'}</button>
                      <button
                        type="button"
                        className={`proxy-vendor-recommend ${vendor.recommended ? 'on' : ''}`}
                        disabled={busy === vendor.id}
                        onClick={() => void update(vendor, { recommended: !vendor.recommended })}
                      >{vendor.recommended ? '★ 推荐' : '☆ 推荐'}</button>
                    </div>
                  </td>
                  <td className="row-actions">
                    <button type="button" className="link-button" disabled={busy === vendor.id} onClick={() => openEdit(vendor)}>编辑</button>
                    <button type="button" className="link-danger" disabled={busy === vendor.id} onClick={() => void remove(vendor)}>删除</button>
                  </td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={7} className="empty-cell">没有符合条件的代理平台</td></tr>
              )}
              {loading && (
                <tr><td colSpan={7} className="empty-cell">加载中…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editor && (
        <div className="modal-backdrop" onClick={() => !busy && setEditor(null)}>
          <section className="modal proxy-vendor-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h3>{editor.id ? '编辑代理平台' : '添加代理平台'}</h3>
            {error && <div className="proxy-vendors-error" role="alert">{error}</div>}
            <div className="proxy-vendor-form-grid">
              <label className="field">
                <span>平台名称 *</span>
                <input autoFocus maxLength={80} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
              </label>
              <label className="field">
                <span>分类 *</span>
                <select value={editor.region} onChange={(event) => setEditor({ ...editor, region: event.target.value as ProxyVendorRegion })}>
                  <option value="global">全球代理</option>
                  <option value="china">中国代理</option>
                </select>
              </label>
              <label className="field proxy-vendor-wide">
                <span>官网 / 购买链接 *</span>
                <input type="url" value={editor.purchaseUrl} placeholder="https://..." onChange={(event) => setEditor({ ...editor, purchaseUrl: event.target.value })} />
              </label>
              <label className="field proxy-vendor-wide">
                <span>Logo 图片链接（可选）</span>
                <input type="url" value={editor.logoUrl} placeholder="https://.../logo.png" onChange={(event) => setEditor({ ...editor, logoUrl: event.target.value })} />
              </label>
              <label className="field proxy-vendor-wide">
                <span>客户端简介</span>
                <textarea rows={3} maxLength={240} value={editor.summary} onChange={(event) => setEditor({ ...editor, summary: event.target.value })} />
              </label>
              <label className="field">
                <span>角标</span>
                <input maxLength={24} value={editor.badge} placeholder="例如：优惠" onChange={(event) => setEditor({ ...editor, badge: event.target.value })} />
              </label>
              <label className="field">
                <span>按钮文字</span>
                <input maxLength={20} value={editor.buttonLabel} onChange={(event) => setEditor({ ...editor, buttonLabel: event.target.value })} />
              </label>
              <label className="field">
                <span>排序（小号优先）</span>
                <input type="number" value={editor.sortOrder} onChange={(event) => setEditor({ ...editor, sortOrder: Number(event.target.value) || 0 })} />
              </label>
              <div className="proxy-vendor-checks">
                <label><input type="checkbox" checked={editor.enabled} onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })} /> 上架展示</label>
                <label><input type="checkbox" checked={editor.recommended} onChange={(event) => setEditor({ ...editor, recommended: event.target.checked })} /> 推荐标记</label>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-sm btn-ghost" disabled={Boolean(busy)} onClick={() => setEditor(null)}>取消</button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={Boolean(busy) || !editor.name.trim() || !editor.purchaseUrl.trim()}
                onClick={() => void save()}
              >{busy ? '保存中…' : '保存'}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
