import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight,
  CircleAlert,
  ClipboardList,
  ExternalLink,
  Globe2,
  Link2,
  LockKeyhole,
  MapPin,
  MoreHorizontal,
  Network,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldX,
  ShoppingCart,
  Trash2,
  X
} from 'lucide-react'
import type { ChannelState } from '@shared/domain'
import type { AccountNetworkState, AccountNetworkStatus } from '@shared/network'
import type { AccountConfig, AppSettings, ProxyAsset } from '@shared/settings'
import type { ProxyVendor, ProxyVendorRegion } from '@shared/proxy-vendor'
import {
  composeProxyUrl,
  PROXY_PROTOCOL_OPTIONS,
  splitProxyInput,
  type ProxyProtocol
} from '@shared/proxy-input'
import whatsappLogo from '../assets/platforms/whatsapp.svg'
import telegramLogo from '../assets/platforms/telegram.svg'
import lineLogo from '../assets/platforms/line.svg'
import kakaoTalkLogo from '../assets/platforms/kakaotalk.svg'
import facebookLogo from '../assets/platforms/facebook.svg'
import instagramLogo from '../assets/platforms/instagram.svg'
import tiktokLogo from '../assets/platforms/tiktok.svg'
import xLogo from '../assets/platforms/x.svg'
import snapchatLogo from '../assets/platforms/snapchat.svg'
import { useI18n } from '../i18n'
import { errText } from '../errors'

const api = window.omni

interface Props {
  settings: AppSettings
  channels: Record<string, ChannelState>
  networks: Record<string, AccountNetworkState>
  onSettings: (settings: AppSettings) => void
  onOpenAccount: (key: string) => void
}

interface PlatformMeta {
  label: string
  logo: string
  color: string
}

interface ProxyDisplay {
  protocol: ProxyProtocol
  host: string
  endpoint: string
}

interface ProxyBinding {
  key: string
  account: AccountConfig
  channel?: ChannelState
  platform: string
  meta: PlatformMeta
}

interface ProxyRow {
  id: string
  sequence: number
  asset: ProxyAsset
  proxy: ProxyDisplay
  bindings: ProxyBinding[]
  status: AccountNetworkStatus
  exitIp?: string
  latencyMs?: number
  checkedAt?: number
}

interface ProxyEditorState {
  mode: 'create' | 'edit'
  assetId?: string
  protocol: ProxyProtocol
  address: string
  note: string
}

interface ProxyBindingState {
  assetId: string
  platform: string
  query: string
  selectedKeys: string[]
}

interface ProxyActionMenuState {
  assetId: string
  top: number
  left: number
}

type StatusFilter = 'all' | 'ready' | 'blocked' | 'checking'
type ProxyPageTab = 'list' | ProxyVendorRegion

const PLATFORM_META: Record<string, PlatformMeta> = {
  whatsapp: { label: 'WhatsApp', color: '#25d366', logo: whatsappLogo },
  telegram: { label: 'Telegram', color: '#229ed9', logo: telegramLogo },
  telegram_bot: { label: 'Telegram Bot', color: '#229ed9', logo: telegramLogo },
  line: { label: 'LINE', color: '#06c755', logo: lineLogo },
  kakaotalk: { label: 'KakaoTalk', color: '#f3c800', logo: kakaoTalkLogo },
  facebook: { label: 'Facebook Messenger', color: '#0866ff', logo: facebookLogo },
  instagram: { label: 'Instagram', color: '#c13584', logo: instagramLogo },
  tiktok: { label: 'TikTok', color: '#111111', logo: tiktokLogo },
  x: { label: 'X', color: '#111111', logo: xLogo },
  snapchat: { label: 'Snapchat', color: '#e6c900', logo: snapchatLogo }
}

const FALLBACK_PLATFORM: PlatformMeta = {
  label: 'Unknown',
  color: '#94a3b8',
  logo: telegramLogo
}

function proxyDisplay(raw: string): ProxyDisplay {
  const draft = splitProxyInput(raw)
  try {
    const parsed = new URL(composeProxyUrl(draft.protocol, draft.address))
    const host = parsed.hostname.includes(':') ? `[${parsed.hostname.replace(/^\[|\]$/g, '')}]` : parsed.hostname
    return {
      protocol: draft.protocol,
      host,
      endpoint: `${host}${parsed.port ? `:${parsed.port}` : ''}`,
    }
  } catch {
    const endpoint = draft.address.replace(/^[^@\s]+@/, '***@') || '格式异常'
    return {
      protocol: draft.protocol,
      host: endpoint,
      endpoint
    }
  }
}

function formatDate(value?: number): string {
  if (!value || !Number.isFinite(value)) return '—'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value)
}

function accountName(key: string, account: AccountConfig, channel?: ChannelState): string {
  return account.label || channel?.selfName || key.slice(key.indexOf(':') + 1)
}

/** 平台账号对外可见的用户名/号码；内部 account key 绝不能作为客户看到的 ID。 */
function accountPublicId(platform: string, channel?: ChannelState): string {
  const handle = channel?.selfHandle?.trim()
  if (!handle) return 'ID 未获取'
  if ((platform === 'telegram' || platform === 'telegram_bot') && !handle.startsWith('@') && !handle.startsWith('+')) {
    return `@${handle}`
  }
  if (platform === 'whatsapp' && /^\d+$/.test(handle)) return `+${handle}`
  return handle
}

function effectiveStatus(
  asset: ProxyAsset,
  bindingKeys: string[],
  networks: Record<string, AccountNetworkState>,
  busy: boolean,
  error?: string
): AccountNetworkStatus {
  if (busy) return 'checking'
  if (error) return 'blocked'
  if (bindingKeys.some((key) => networks[key]?.status === 'blocked')) return 'blocked'
  return asset.verification ? 'ready' : 'unconfigured'
}

function statusLabel(status: AccountNetworkStatus): string {
  if (status === 'ready') return '可用'
  if (status === 'checking') return '检测中'
  if (status === 'blocked') return '异常'
  return '未检测'
}

function matchesStatus(status: AccountNetworkStatus, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'blocked') return status === 'blocked' || status === 'unconfigured'
  return status === filter
}

function vendorInitials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || 'IP'
}

function VendorLogo({ vendor }: { vendor: ProxyVendor }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [vendor.logoUrl])
  return (
    <span className="proxy-market-logo" aria-hidden>
      {vendor.logoUrl && !failed
        ? <img src={vendor.logoUrl} alt="" onError={() => setFailed(true)} />
        : vendorInitials(vendor.name)}
    </span>
  )
}

export function ProxyPage({
  settings,
  channels,
  networks,
  onSettings,
  onOpenAccount
}: Props): React.JSX.Element {
  const { t } = useI18n()
  const keys = useMemo(() => Object.keys(settings.accounts).sort(), [settings.accounts])
  const [query, setQuery] = useState('')
  const [protocolFilter, setProtocolFilter] = useState<'all' | ProxyProtocol>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [editor, setEditor] = useState<ProxyEditorState | null>(null)
  const [binding, setBinding] = useState<ProxyBindingState | null>(null)
  const [actionMenu, setActionMenu] = useState<ProxyActionMenuState | null>(null)
  const [editorError, setEditorError] = useState('')
  const [bindingError, setBindingError] = useState('')
  const [editorProbe, setEditorProbe] = useState<{ exitIp?: string; latencyMs: number } | null>(null)
  const [activeTab, setActiveTab] = useState<ProxyPageTab>('list')
  const [vendors, setVendors] = useState<ProxyVendor[]>([])
  const [vendorQuery, setVendorQuery] = useState('')
  const [vendorLoading, setVendorLoading] = useState(true)
  const [vendorError, setVendorError] = useState('')

  const loadVendors = useCallback(async (): Promise<void> => {
    setVendorLoading(true)
    setVendorError('')
    try {
      const result = await api.billing<{ vendors: ProxyVendor[] }>('listProxyVendors')
      setVendors(result.vendors)
    } catch (error) {
      setVendorError(errText(error))
    } finally {
      setVendorLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadVendors()
  }, [loadVendors])

  const rows = useMemo<ProxyRow[]>(() => {
    const assets = Object.values(settings.proxyAssets)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    return assets.map((asset, index) => {
      const bindings = keys
        .filter((key) => settings.accounts[key]?.proxyId === asset.id)
        .map((key) => {
          const account = settings.accounts[key] ?? {}
          const platform = key.split(':', 1)[0] ?? key
          return {
            key,
            account,
            channel: channels[key],
            platform,
            meta: PLATFORM_META[platform] ?? { ...FALLBACK_PLATFORM, label: platform }
          }
        })
      return {
        id: asset.id,
        sequence: index + 1,
        asset,
        proxy: proxyDisplay(asset.proxyUrl),
        bindings,
        status: effectiveStatus(asset, bindings.map((item) => item.key), networks, busy === asset.id, errors[asset.id]),
        exitIp: asset.verification?.exitIp,
        latencyMs: asset.verification?.latencyMs,
        checkedAt: asset.verification?.checkedAt
      }
    })
  }, [busy, channels, errors, keys, networks, settings.accounts, settings.proxyAssets])

  const accountCatalog = useMemo<ProxyBinding[]>(() => keys.map((key) => {
    const account = settings.accounts[key] ?? {}
    const platform = key.split(':', 1)[0] ?? key
    return {
      key,
      account,
      channel: channels[key],
      platform,
      meta: PLATFORM_META[platform] ?? { ...FALLBACK_PLATFORM, label: platform }
    }
  }).sort((left, right) => (
    left.meta.label.localeCompare(right.meta.label) ||
    accountName(left.key, left.account, left.channel).localeCompare(accountName(right.key, right.account, right.channel))
  )), [channels, keys, settings.accounts])

  const bindingPlatforms = useMemo(() => {
    const available = new Set(accountCatalog.map((item) => item.platform))
    return [...new Set([
      ...settings.platformOrder.filter((platform) => available.has(platform)),
      ...accountCatalog.map((item) => item.platform)
    ])]
  }, [accountCatalog, settings.platformOrder])

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return rows.filter((row) => {
      if (protocolFilter !== 'all' && row.proxy.protocol !== protocolFilter) return false
      if (!matchesStatus(row.status, statusFilter)) return false
      if (!needle) return true
      const haystack = [
        row.proxy.endpoint,
        row.exitIp,
        row.asset.note,
        row.id,
        ...row.bindings.flatMap((item) => [
          item.meta.label,
          accountName(item.key, item.account, item.channel),
          item.key
        ])
      ].filter(Boolean).join(' ').toLocaleLowerCase()
      return haystack.includes(needle)
    })
  }, [protocolFilter, query, rows, statusFilter])

  const readyCount = rows.filter((row) => row.status === 'ready').length
  const blockedCount = rows.filter((row) => row.status === 'blocked' || row.status === 'unconfigured').length
  const unconfiguredKeys = keys.filter((key) => !settings.accounts[key]?.proxyId)
  const visibleVendors = useMemo(() => {
    if (activeTab === 'list') return []
    const needle = vendorQuery.trim().toLocaleLowerCase()
    return vendors.filter((vendor) => vendor.region === activeTab && (
      !needle || [vendor.name, vendor.summary, vendor.badge]
        .join(' ')
        .toLocaleLowerCase()
        .includes(needle)
    ))
  }, [activeTab, vendorQuery, vendors])

  const openCreate = (): void => {
    setEditor({ mode: 'create', protocol: 'socks5', address: '', note: '' })
    setEditorError('')
    setEditorProbe(null)
  }

  const openEdit = (asset: ProxyAsset): void => {
    const draft = splitProxyInput(asset.proxyUrl)
    setEditor({
      mode: 'edit',
      assetId: asset.id,
      protocol: draft.protocol,
      address: draft.address,
      note: asset.note ?? ''
    })
    setEditorError('')
    setEditorProbe(null)
  }

  const testEditorProxy = async (): Promise<void> => {
    if (!editor) return
    const proxyUrl = composeProxyUrl(editor.protocol, editor.address)
    if (!proxyUrl) {
      setEditorError('必须填写代理服务器地址。')
      return
    }
    const busyKey = editor.assetId ?? 'new'
    setBusy(busyKey)
    setEditorError('')
    setEditorProbe(null)
    try {
      const probe = await api.testProxy(proxyUrl)
      setEditorProbe({ exitIp: probe.exitIp, latencyMs: probe.latencyMs })
    } catch {
      setEditorError('网络错误')
    } finally {
      setBusy(null)
    }
  }

  const saveEditor = async (): Promise<void> => {
    if (!editor) return
    const proxyUrl = composeProxyUrl(editor.protocol, editor.address)
    if (!proxyUrl) {
      setEditorError('必须填写代理服务器地址。')
      return
    }
    const busyKey = editor.assetId ?? 'new'
    setBusy(busyKey)
    setEditorError('')
    try {
      const result = await api.saveProxyAsset({
        id: editor.assetId,
        proxyUrl,
        note: editor.note
      })
      onSettings(result.settings)
      setEditor(null)
    } catch (error) {
      setEditorError(errText(error))
    } finally {
      setBusy(null)
    }
  }

  const checkRow = async (row: ProxyRow): Promise<void> => {
    setBusy(row.id)
    setErrors((current) => ({ ...current, [row.id]: '' }))
    try {
      const result = await api.saveProxyAsset({
        id: row.id,
        proxyUrl: row.asset.proxyUrl,
        note: row.asset.note,
        verify: true
      })
      onSettings(result.settings)
    } catch (error) {
      setErrors((current) => ({ ...current, [row.id]: errText(error) }))
    } finally {
      setBusy(null)
    }
  }

  const openBinding = (row: ProxyRow): void => {
    setBinding({
      assetId: row.id,
      platform: row.bindings[0]?.platform ?? bindingPlatforms[0] ?? '',
      query: '',
      selectedKeys: row.bindings.map((item) => item.key)
    })
    setBindingError('')
  }

  const saveBinding = async (): Promise<void> => {
    if (!binding) return
    setBusy(binding.assetId)
    setBindingError('')
    try {
      onSettings(await api.setProxyAssetBindings(binding.assetId, binding.selectedKeys))
      setBinding(null)
    } catch (error) {
      setBindingError(errText(error))
    } finally {
      setBusy(null)
    }
  }

  const deleteRow = async (row: ProxyRow): Promise<void> => {
    const suffix = row.bindings.length > 0 ? `\n${row.bindings.length} 个关联账号将被安全断开并解除关联。` : ''
    if (!window.confirm(`确定删除这条代理记录？${suffix}`)) return
    setBusy(row.id)
    setErrors((current) => ({ ...current, [row.id]: '' }))
    try {
      onSettings(await api.deleteProxyAsset(row.id))
    } catch (error) {
      setErrors((current) => ({ ...current, [row.id]: errText(error) }))
    } finally {
      setBusy(null)
    }
  }

  const openActionMenu = (row: ProxyRow, anchor: HTMLButtonElement): void => {
    const rect = anchor.getBoundingClientRect()
    const menuWidth = 154
    const menuHeight = row.bindings[0] ? 116 : 80
    const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth))
    const top = rect.bottom + 6 + menuHeight > window.innerHeight
      ? Math.max(8, rect.top - menuHeight - 6)
      : rect.bottom + 6
    setActionMenu({ assetId: row.id, top, left })
  }

  const bindingAsset = binding ? settings.proxyAssets[binding.assetId] : undefined
  const bindingRows = binding
    ? rows.find((row) => row.id === binding.assetId)?.bindings ?? []
    : []
  const bindingSelected = new Set(binding?.selectedKeys ?? [])
  const visibleBindingAccounts = binding
    ? accountCatalog.filter((item) => {
        if (item.platform !== binding.platform) return false
        const needle = binding.query.trim().toLocaleLowerCase()
        if (!needle) return true
        return [
          accountName(item.key, item.account, item.channel),
          accountPublicId(item.platform, item.channel),
          item.key
        ].join(' ').toLocaleLowerCase().includes(needle)
      })
    : []
  const currentBindingKeys = new Set(bindingRows.map((item) => item.key))
  const bindingDirty = Boolean(binding) && (
    bindingSelected.size !== currentBindingKeys.size ||
    [...bindingSelected].some((key) => !currentBindingKeys.has(key))
  )
  const allVisibleSelected = visibleBindingAccounts.length > 0 &&
    visibleBindingAccounts.every((item) => bindingSelected.has(item.key))

  const toggleBindingAccount = (key: string): void => {
    setBinding((current) => {
      if (!current) return current
      const selected = new Set(current.selectedKeys)
      if (selected.has(key)) selected.delete(key)
      else selected.add(key)
      return { ...current, selectedKeys: [...selected] }
    })
    setBindingError('')
  }

  const toggleVisibleBindings = (): void => {
    setBinding((current) => {
      if (!current || visibleBindingAccounts.length === 0) return current
      const selected = new Set(current.selectedKeys)
      const remove = visibleBindingAccounts.every((item) => selected.has(item.key))
      for (const item of visibleBindingAccounts) {
        if (remove) selected.delete(item.key)
        else selected.add(item.key)
      }
      return { ...current, selectedKeys: [...selected] }
    })
    setBindingError('')
  }
  const editorBusy = editor ? busy === (editor.assetId ?? 'new') : false
  const actionMenuRow = actionMenu ? rows.find((row) => row.id === actionMenu.assetId) : undefined

  return (
    <div className="page proxy-page">
      <header className="page-header proxy-header">
        <div className="proxy-header-copy">
          <div className="page-kicker"><LockKeyhole size={17} /> 安全隔离</div>
          <h1>{t('management.proxy')}</h1>
          <p>先集中添加和检测代理，再按需关联平台账号。平台流量只使用已关联出口，断线立即阻断。</p>
        </div>
        <div className="proxy-summary" aria-label="代理概览">
          <div><strong>{rows.length}</strong><span>代理总数</span></div>
          <div className="is-ready"><strong>{readyCount}</strong><span>可用</span></div>
          <div className="is-pending"><strong>{unconfiguredKeys.length}</strong><span>账号待关联</span></div>
        </div>
      </header>

      <div className="page-body proxy-body">
        <nav className="proxy-page-tabs" role="tablist" aria-label="代理页面">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'list'}
            className={activeTab === 'list' ? 'is-active' : ''}
            onClick={() => setActiveTab('list')}
          >
            <ClipboardList size={16} /> 代理列表
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'global'}
            className={activeTab === 'global' ? 'is-active' : ''}
            onClick={() => setActiveTab('global')}
          >
            <Globe2 size={16} /> 全球代理
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'china'}
            className={activeTab === 'china' ? 'is-active' : ''}
            onClick={() => setActiveTab('china')}
          >
            <MapPin size={16} /> 中国代理
          </button>
        </nav>

        {activeTab === 'list' && <section className="proxy-table-panel">
          <div className="proxy-table-toolbar">
            <label className="proxy-table-search">
              <Search size={17} />
              <input
                value={query}
                placeholder="搜索代理、出口 IP、备注或账号"
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={15} /></button>}
            </label>
            <select value={protocolFilter} onChange={(event) => setProtocolFilter(event.target.value as 'all' | ProxyProtocol)}>
              <option value="all">全部协议</option>
              {PROXY_PROTOCOL_OPTIONS.map((protocol) => (
                <option key={protocol} value={protocol}>{protocol.toUpperCase()}</option>
              ))}
            </select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
              <option value="all">全部状态</option>
              <option value="ready">可用</option>
              <option value="checking">检测中</option>
              <option value="blocked">异常 / 未检测</option>
            </select>
            <span className="proxy-filter-count">显示 {filteredRows.length} / {rows.length}</span>
            <button type="button" className="primary-btn proxy-add-btn" onClick={openCreate}>
              <Plus size={17} /> 添加代理
            </button>
          </div>

          <div className="proxy-table-scroll">
            <table className="proxy-management-table">
              <thead>
                <tr>
                  <th>编号</th>
                  <th>代理服务器</th>
                  <th>出口 IP</th>
                  <th>备注</th>
                  <th>关联平台</th>
                  <th>关联账号</th>
                  <th>网络状态</th>
                  <th>创建时间</th>
                  <th className="proxy-actions-heading">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const error = errors[row.id]
                  const checking = busy === row.id
                  return (
                    <tr key={row.id}>
                      <td className="proxy-number">{String(row.sequence).padStart(3, '0')}</td>
                      <td className="proxy-server-cell">
                        <div className="proxy-server-line">
                          <span className={`proxy-protocol-badge is-${row.proxy.protocol}`}>{row.proxy.protocol.toUpperCase()}</span>
                        </div>
                      </td>
                      <td>
                        <code
                          className="proxy-ip-value"
                          title={row.exitIp ? '历史检测记录中的出口 IP' : '当前检测只验证代理连通性'}
                        >
                          {row.exitIp || '—'}
                        </code>
                      </td>
                      <td><span className={`proxy-note ${row.asset.note?.trim() ? '' : 'is-empty'}`} title={row.asset.note || ''}>{row.asset.note?.trim() || '未填写'}</span></td>
                      <td>
                        {row.bindings.length === 0 ? <span className="proxy-unbound">未关联</span> : (
                          <div className="proxy-binding-stack">
                            {row.bindings.map((item) => (
                              <span key={item.key} className="proxy-platform-chip" style={{ '--platform-color': item.meta.color } as React.CSSProperties}>
                                <img src={item.meta.logo} alt="" /> {item.meta.label}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        {row.bindings.length === 0 ? <span className="proxy-unbound">待关联账号</span> : (
                          <div className="proxy-binding-stack">
                            {row.bindings.map((item) => (
                              <div key={item.key} className="proxy-account-cell">
                                <strong>{accountName(item.key, item.account, item.channel)}</strong>
                                <span title={accountPublicId(item.platform, item.channel)}>{accountPublicId(item.platform, item.channel)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="proxy-network-cell">
                          <span className={`proxy-table-status is-${row.status}`} title={error || ''}>
                            {row.status === 'ready' ? <ShieldCheck size={14} /> : row.status === 'checking' ? <RefreshCw size={14} /> : <ShieldX size={14} />}
                            {statusLabel(row.status)}
                          </span>
                        </div>
                      </td>
                      <td><time className="proxy-created-time">{formatDate(row.asset.createdAt)}</time></td>
                      <td className="proxy-actions-cell">
                        <div className="proxy-row-actions">
                          <button type="button" className="is-test" disabled={checking} title="检测代理" onClick={() => void checkRow(row)}>
                            <RefreshCw size={15} className={checking ? 'is-spinning' : ''} /> 检测
                          </button>
                          <button type="button" className="is-bind" disabled={checking} title="关联平台账号" onClick={() => openBinding(row)}>
                            <Link2 size={15} /> 关联
                          </button>
                          <button
                            type="button"
                            className="is-more"
                            disabled={checking}
                            title="更多操作"
                            aria-label="更多操作"
                            aria-haspopup="menu"
                            aria-expanded={actionMenu?.assetId === row.id}
                            onClick={(event) => openActionMenu(row, event.currentTarget)}
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr className="proxy-empty-row">
                    <td colSpan={9}>
                      <div className="proxy-table-empty">
                        <Network size={34} />
                        <strong>还没有代理记录</strong>
                        <span>先添加并检测代理，保存成功后再关联平台账号。</span>
                        <button type="button" className="primary-btn" onClick={openCreate}>添加代理</button>
                      </div>
                    </td>
                  </tr>
                )}
                {rows.length > 0 && filteredRows.length === 0 && (
                  <tr className="proxy-empty-row">
                    <td colSpan={9}><div className="proxy-filter-empty"><Search size={24} /><span>没有符合当前筛选条件的代理。</span></div></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {rows.length > 0 && (
            <footer className="proxy-table-footer">
              <span>共 {rows.length} 条代理记录</span>
              <span className="is-ready">{readyCount} 条可用</span>
              <span className={blockedCount > 0 ? 'is-blocked' : ''}>{blockedCount} 条异常或未检测</span>
              <span>{unconfiguredKeys.length} 个账号尚未关联代理</span>
            </footer>
          )}
        </section>}

        {activeTab !== 'list' && (
          <section className="proxy-marketplace-panel">
            <div className="proxy-marketplace-toolbar">
              <div>
                <div className="proxy-marketplace-title-line">
                  <h2>{activeTab === 'global' ? '全球代理平台' : '中国代理平台'}</h2>
                  {!vendorLoading && !vendorError && <span>{visibleVendors.length} 个平台</span>}
                </div>
                <p>选择供应商后将打开其官网或购买页面。</p>
              </div>
              <label className="proxy-marketplace-search">
                <Search size={16} />
                <input
                  value={vendorQuery}
                  placeholder="搜索代理平台"
                  onChange={(event) => setVendorQuery(event.target.value)}
                />
                {vendorQuery && <button type="button" aria-label="清空搜索" onClick={() => setVendorQuery('')}><X size={14} /></button>}
              </label>
            </div>

            {vendorError && (
              <div className="proxy-marketplace-error" role="alert">
                <CircleAlert size={17} />
                <span>代理平台加载失败</span>
                <button type="button" onClick={() => void loadVendors()}>重试</button>
              </div>
            )}

            {vendorLoading ? (
              <div className="proxy-marketplace-empty"><RefreshCw size={25} className="is-spinning" /><span>正在加载代理平台…</span></div>
            ) : visibleVendors.length > 0 ? (
              <div className="proxy-marketplace-grid">
                {visibleVendors.map((vendor) => (
                  <article key={vendor.id} className={`proxy-market-card ${vendor.recommended ? 'is-recommended' : ''}`}>
                    {(vendor.badge || vendor.recommended) && (
                      <span className="proxy-market-badge">{vendor.badge || '推荐'}</span>
                    )}
                    <div className="proxy-market-card-main">
                      <VendorLogo vendor={vendor} />
                      <div>
                        <h3>{vendor.name}</h3>
                        <p>{vendor.summary || '点击查看该代理平台提供的产品与套餐。'}</p>
                      </div>
                    </div>
                    <a href={vendor.purchaseUrl} target="_blank" rel="noreferrer">
                      <ShoppingCart size={16} />
                      {vendor.buttonLabel || '立即访问'}
                      <ExternalLink size={14} />
                    </a>
                  </article>
                ))}
              </div>
            ) : (
              <div className="proxy-marketplace-empty">
                <ShoppingCart size={28} />
                <strong>{vendorQuery ? '没有符合条件的平台' : '暂未上架代理平台'}</strong>
                <span>{vendorQuery ? '换一个关键词试试。' : '管理员可在后台“代理平台”中添加。'}</span>
              </div>
            )}

            <footer className="proxy-marketplace-notice">
              第三方服务由供应商独立提供，购买前请自行核对套餐、地区与合规要求。
            </footer>
          </section>
        )}
      </div>

      {actionMenu && actionMenuRow && (
        <>
          <button type="button" className="proxy-action-menu-scrim" aria-label="关闭操作菜单" onClick={() => setActionMenu(null)} />
          <div className="proxy-action-menu" role="menu" style={{ top: actionMenu.top, left: actionMenu.left }}>
            <button type="button" role="menuitem" onClick={() => { setActionMenu(null); openEdit(actionMenuRow.asset) }}>
              <PencilLine size={15} /> 编辑代理
            </button>
            {actionMenuRow.bindings[0] && (
              <button type="button" role="menuitem" onClick={() => { setActionMenu(null); onOpenAccount(actionMenuRow.bindings[0]!.key) }}>
                <ArrowUpRight size={15} /> 打开关联账号
              </button>
            )}
            <button type="button" role="menuitem" className="is-danger" onClick={() => { setActionMenu(null); void deleteRow(actionMenuRow) }}>
              <Trash2 size={15} /> 删除代理
            </button>
          </div>
        </>
      )}

      {editor && (
        <div className="modal-backdrop" onClick={() => !editorBusy && setEditor(null)}>
          <section
            className="proxy-editor-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="proxy-editor-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="proxy-editor-icon"><PencilLine size={20} /></span>
                <div>
                  <h2 id="proxy-editor-title">{editor.mode === 'create' ? '添加代理' : '编辑代理'}</h2>
                  <p>代理先保存到独立代理库，保存成功后再关联平台账号。</p>
                </div>
              </div>
              <button type="button" aria-label="关闭" disabled={editorBusy} onClick={() => setEditor(null)}><X size={19} /></button>
            </header>

            <div className="proxy-editor-body">
              <label className="field proxy-editor-address-field">
                <span>代理服务器</span>
                <div className="proxy-editor-address">
                  <select
                    value={editor.protocol}
                    disabled={editorBusy}
                    aria-label="代理协议"
                    onChange={(event) => {
                      setEditor({ ...editor, protocol: event.target.value as ProxyProtocol })
                      setEditorError('')
                      setEditorProbe(null)
                    }}
                  >
                    {PROXY_PROTOCOL_OPTIONS.map((protocol) => (
                      <option key={protocol} value={protocol}>{protocol.toUpperCase()}</option>
                    ))}
                  </select>
                  <input
                    autoFocus
                    value={editor.address}
                    disabled={editorBusy}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="IP:端口 或 IP:端口:账号:密码"
                    onChange={(event) => {
                      const draft = splitProxyInput(event.target.value, editor.protocol)
                      setEditor({ ...editor, protocol: draft.protocol, address: draft.address })
                      setEditorError('')
                      setEditorProbe(null)
                    }}
                  />
                </div>
              </label>
              <p className="proxy-editor-hint">默认 SOCKS5；支持直接粘贴代理商提供的地址，账号与密码只保存在本机受限配置中。</p>

              <label className="field">
                <span>备注</span>
                <input
                  value={editor.note}
                  maxLength={160}
                  disabled={editorBusy}
                  placeholder="例如：美国住宅 IP / 售后团队专用"
                  onChange={(event) => setEditor({ ...editor, note: event.target.value })}
                />
              </label>

              <div className="proxy-editor-library-note">
                <Network size={18} />
                <div><strong>独立代理资产</strong><span>此处不选择账号；可在列表或账号右键“代理配置”中完成关联。</span></div>
                <span>未关联</span>
              </div>

              {editorError && <div className="proxy-editor-error" role="alert"><CircleAlert size={17} /> <span>{editorError}</span></div>}
              {editorProbe && (
                <div className="proxy-editor-test-result" role="status">
                  <ShieldCheck size={18} />
                  <div>
                    <strong>可用</strong>
                    <span>{Math.round(editorProbe.latencyMs)} ms</span>
                  </div>
                </div>
              )}
            </div>

            <footer>
              <button type="button" className="ghost-btn" disabled={editorBusy} onClick={() => setEditor(null)}>取消</button>
              <button
                type="button"
                className="ghost-btn proxy-test-save"
                disabled={editorBusy || !editor.address.trim()}
                onClick={() => void testEditorProxy()}
              >
                {editorBusy ? <RefreshCw size={16} className="is-spinning" /> : <ShieldCheck size={16} />} 检测代理
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={editorBusy || !editor.address.trim()}
                onClick={() => void saveEditor()}
              >
                {editorBusy ? '保存中…' : '保存代理'}
              </button>
            </footer>
          </section>
        </div>
      )}

      {binding && bindingAsset && (
        <div className="modal-backdrop" onClick={() => !busy && setBinding(null)}>
          <section
            className="proxy-editor-modal proxy-binding-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="proxy-binding-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="proxy-editor-icon"><Link2 size={20} /></span>
                <div>
                  <h2 id="proxy-binding-title">关联平台账号</h2>
                  <p>选择账号后将固定使用此代理；不会在这里自动打开登录。</p>
                </div>
              </div>
              <button type="button" aria-label="关闭" disabled={Boolean(busy)} onClick={() => setBinding(null)}><X size={19} /></button>
            </header>
            <div className="proxy-editor-body">
              <div className="proxy-binding-asset">
                <span className={`proxy-protocol-badge is-${proxyDisplay(bindingAsset.proxyUrl).protocol}`}>
                  {proxyDisplay(bindingAsset.proxyUrl).protocol.toUpperCase()}
                </span>
                <div><strong>{proxyDisplay(bindingAsset.proxyUrl).endpoint}</strong><span>{bindingAsset.note || '未填写备注'} · 出口 {bindingAsset.verification?.exitIp || '未检测'}</span></div>
                <b>{bindingSelected.size} 个账号</b>
              </div>

              <div className="proxy-binding-section-heading">
                <strong>选择平台</strong>
                <span>不同平台的勾选会同时保留</span>
              </div>
              <div className="proxy-binding-platform-tabs" role="tablist" aria-label="选择平台">
                {bindingPlatforms.map((platform) => {
                  const items = accountCatalog.filter((item) => item.platform === platform)
                  const selectedCount = items.filter((item) => bindingSelected.has(item.key)).length
                  const meta = PLATFORM_META[platform] ?? { ...FALLBACK_PLATFORM, label: platform }
                  return (
                    <button
                      key={platform}
                      type="button"
                      role="tab"
                      aria-selected={binding.platform === platform}
                      className={binding.platform === platform ? 'is-active' : ''}
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setBinding({ ...binding, platform, query: '' })
                        setBindingError('')
                      }}
                    >
                      <img src={meta.logo} alt="" />
                      <span>{meta.label}</span>
                      <small>{selectedCount > 0 ? `${selectedCount}/` : ''}{items.length}</small>
                    </button>
                  )
                })}
              </div>

              <div className="proxy-binding-section-heading proxy-binding-account-heading">
                <strong>筛选账号</strong>
                <span>{visibleBindingAccounts.length} 个结果</span>
              </div>
              <div className="proxy-binding-tools">
                <label className="proxy-binding-search">
                  <Search size={16} />
                  <input
                    autoFocus
                    value={binding.query}
                    disabled={Boolean(busy) || !binding.platform}
                    placeholder="搜索账号昵称或 ID"
                    onChange={(event) => setBinding({ ...binding, query: event.target.value })}
                  />
                  {binding.query && (
                    <button type="button" aria-label="清空搜索" onClick={() => setBinding({ ...binding, query: '' })}>
                      <X size={14} />
                    </button>
                  )}
                </label>
                <button
                  type="button"
                  className="ghost-btn proxy-binding-select-all"
                  disabled={Boolean(busy) || visibleBindingAccounts.length === 0}
                  onClick={toggleVisibleBindings}
                >
                  {allVisibleSelected ? '取消全选' : '全选结果'}
                </button>
              </div>

              <div className="proxy-binding-account-list" role="group" aria-label="平台账号多选列表">
                {visibleBindingAccounts.map((item) => {
                  const selected = bindingSelected.has(item.key)
                  const linkedHere = item.account.proxyId === binding.assetId
                  const linkedElsewhere = Boolean(item.account.proxyId && !linkedHere)
                  const stateLabel = selected
                    ? linkedHere ? '已关联' : linkedElsewhere ? '将替换原代理' : '待关联'
                    : linkedHere ? '将解除' : linkedElsewhere ? '已有其他代理' : '未关联'
                  return (
                    <label key={item.key} className={`proxy-binding-account-option ${selected ? 'is-selected' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={Boolean(busy)}
                        onChange={() => toggleBindingAccount(item.key)}
                      />
                      <span className="proxy-binding-account-avatar" style={{ '--platform-color': item.meta.color } as React.CSSProperties}>
                        {item.channel?.avatarMediaId
                          ? <img src={`omni-media://local/${item.channel.avatarMediaId}`} alt="" />
                          : <img src={item.meta.logo} alt="" />}
                      </span>
                      <span className="proxy-binding-account-copy">
                        <strong>{accountName(item.key, item.account, item.channel)}</strong>
                        <span>{accountPublicId(item.platform, item.channel)}</span>
                      </span>
                      <span className={`proxy-binding-account-state ${linkedElsewhere ? 'is-replace' : ''} ${linkedHere && !selected ? 'is-remove' : ''}`}>
                        {stateLabel}
                      </span>
                    </label>
                  )
                })}
                {accountCatalog.length === 0 && (
                  <div className="proxy-binding-empty"><Network size={24} /><span>暂无平台账号，请先创建账号。</span></div>
                )}
                {accountCatalog.length > 0 && visibleBindingAccounts.length === 0 && (
                  <div className="proxy-binding-empty"><Search size={24} /><span>没有符合条件的账号。</span></div>
                )}
              </div>

              <div className="proxy-binding-selection-summary">
                <span>已选择 <strong>{bindingSelected.size}</strong> 个账号</span>
                {bindingSelected.size > 0 && (
                  <button type="button" disabled={Boolean(busy)} onClick={() => setBinding({ ...binding, selectedKeys: [] })}>清空选择</button>
                )}
              </div>
              {bindingError && <div className="proxy-editor-error" role="alert"><CircleAlert size={17} /> <span>{bindingError}</span></div>}
            </div>
            <footer>
              <span className="proxy-binding-footer-summary">一个代理可关联多个账号</span>
              <button type="button" className="ghost-btn" disabled={Boolean(busy)} onClick={() => setBinding(null)}>取消</button>
              <button type="button" className="primary-btn" disabled={Boolean(busy) || !bindingDirty} onClick={() => void saveBinding()}>
                {busy ? '保存中…' : `保存关联（${bindingSelected.size}）`}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  )
}
