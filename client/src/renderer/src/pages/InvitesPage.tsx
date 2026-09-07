import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Gift, Link2, RefreshCw, TicketCheck, UserPlus, WalletCards } from 'lucide-react'
import { brand } from '@shared/branding'
import { errText } from '../errors'
import { useI18n } from '../i18n'

const api = window.omni

interface InviteCodeRow {
  code: string
  enabled: boolean
  maxUses: number
  usedCount: number
  expiresAt?: number
  createdAt: number
}

interface ReferralRow {
  userId: number
  email: string
  inviteCode: string
  registeredAt: number
  commissionCents: number
}

interface CommissionRow {
  id: number
  inviteeEmail?: string
  eventType: 'topup' | 'spend'
  baseCents: number
  rateBps: number
  commissionCents: number
  createdAt: number
}

interface InviteDashboard {
  rateBps: number
  totalCommissionCents: number
  invitedCount: number
  codes: InviteCodeRow[]
  referrals: ReferralRow[]
  commissions: CommissionRow[]
}

function money(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`
}

function shareUrl(code: string): string {
  const configured = brand.website || 'https://www.wzzapp.cloud'
  const origin = configured.includes('://wzzapp.cloud')
    ? configured.replace('://wzzapp.cloud', '://www.wzzapp.cloud')
    : configured
  return `${origin.replace(/\/$/, '')}/register.html?invite=${encodeURIComponent(code)}`
}

export function InvitesPage(): React.JSX.Element {
  const { locale } = useI18n()
  const zh = locale === 'zh-CN' || locale === 'zh-TW'
  const [data, setData] = useState<InviteDashboard | null>(null)
  const [customCode, setCustomCode] = useState('')
  const [maxUses, setMaxUses] = useState('0')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      setData(await api.billing<InviteDashboard>('inviteDashboard'))
    } catch (err) {
      setError(errText(err))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const activeCode = useMemo(() => data?.codes.find((row) => row.enabled) ?? data?.codes[0], [data])

  const copy = async (value: string, key: string): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(key)
    window.setTimeout(() => setCopied(''), 1500)
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await api.billing('createInvite', {
        code: customCode.trim() || undefined,
        maxUses: Math.max(0, Number(maxUses) || 0)
      })
      setCustomCode('')
      setMaxUses('0')
      await load()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page invites-page">
      <header className="page-header invites-header">
        <div className="invites-heading">
          <div className="invites-heading-icon"><Gift size={20} /></div>
          <div>
            <div className="page-kicker">{zh ? '增长与返佣' : 'Growth & commission'}</div>
            <h1>{zh ? '邀请码管理' : 'Invitation codes'}</h1>
            <p>{zh ? '邀请关系注册后永久绑定；被邀请人每次充值和消费都会自动返佣。' : 'Referral relationships are permanent. Every top-up and purchase earns commission.'}</p>
          </div>
        </div>
        <button type="button" className="ghost-btn invite-refresh" disabled={busy} onClick={() => void load()}><RefreshCw size={16} />{zh ? '刷新数据' : 'Refresh'}</button>
      </header>

      <div className="page-body invites-body">
        {error && <div className="auth-err invite-error"><span>{error}</span><button type="button" className="ghost-btn small" onClick={() => void load()}>{zh ? '重试' : 'Retry'}</button></div>}
        <div className="invite-stats">
          <div className="invite-stat-card"><span className="invite-stat-icon"><UserPlus size={18} /></span><span>{zh ? '累计邀请' : 'Referrals'}</span><strong>{data?.invitedCount ?? 0}</strong><small>{zh ? '已成功注册的用户' : 'Registered users'}</small></div>
          <div className="invite-stat-card"><span className="invite-stat-icon"><Gift size={18} /></span><span>{zh ? '当前返佣比例' : 'Commission rate'}</span><strong>{((data?.rateBps ?? 0) / 100).toFixed(2)}%</strong><small>{zh ? '充值和消费统一比例' : 'Top-ups and purchases'}</small></div>
          <div className="invite-stat-card"><span className="invite-stat-icon"><WalletCards size={18} /></span><span>{zh ? '累计佣金' : 'Total commission'}</span><strong>{money(data?.totalCommissionCents ?? 0)}</strong><small>{zh ? '已实时计入账户余额' : 'Credited to balance'}</small></div>
        </div>

        {activeCode && (
          <section className="invite-share-card">
            <div>
              <span>{zh ? '主邀请码' : 'Primary invitation code'}</span>
              <strong>{activeCode.code}</strong>
              <small>{zh ? '佣金实时进入余额，可用于套餐与服务消费。' : 'Commission is credited to your balance immediately.'}</small>
            </div>
            <div className="invite-share-actions">
              <button type="button" className="ghost-btn" onClick={() => void copy(activeCode.code, 'code')}><Copy size={16} />{copied === 'code' ? (zh ? '已复制' : 'Copied') : (zh ? '复制邀请码' : 'Copy code')}</button>
              <button type="button" className="primary-btn" onClick={() => void copy(shareUrl(activeCode.code), 'link')}><Link2 size={16} />{copied === 'link' ? (zh ? '已复制' : 'Copied') : (zh ? '复制注册链接' : 'Copy link')}</button>
            </div>
          </section>
        )}

        <section className="invite-panel">
          <div className="invite-panel-head"><div className="invite-panel-title"><span className="invite-panel-icon"><TicketCheck size={17} /></span><div><h2>{zh ? '邀请码' : 'Codes'}</h2><p>{zh ? '创建多个邀请码并分别管理，使用上限填 0 表示不限制。' : 'Create and manage multiple codes. Set the limit to zero for unlimited use.'}</p></div></div></div>
          <div className="invite-create-row">
            <label><span>{zh ? '自定义邀请码' : 'Custom code'}</span><input value={customCode} maxLength={24} placeholder={zh ? '留空则自动生成' : 'Leave blank to generate'} onChange={(e) => setCustomCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} /></label>
            <label><span>{zh ? '使用上限' : 'Usage limit'}</span><input type="number" min="0" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} title={zh ? '最多使用次数，0 为不限' : 'Maximum uses; 0 is unlimited'} /></label>
            <button type="button" className="primary-btn" disabled={busy} onClick={() => void create()}>{busy ? '…' : (zh ? '新增邀请码' : 'Create code')}</button>
          </div>
          <div className="invite-table-scroll">
            <table className="invite-table"><thead><tr><th>{zh ? '邀请码' : 'Code'}</th><th>{zh ? '使用次数' : 'Uses'}</th><th>{zh ? '状态' : 'Status'}</th><th>{zh ? '创建时间' : 'Created'}</th><th>{zh ? '操作' : 'Action'}</th></tr></thead>
              <tbody>{(data?.codes.length ?? 0) === 0 ? <tr><td colSpan={5} className="invite-empty">{zh ? '还没有邀请码，创建后即可分享' : 'Create a code to start inviting users'}</td></tr> : data?.codes.map((row) => <tr key={row.code}><td><code>{row.code}</code></td><td>{row.usedCount} / {row.maxUses || (zh ? '不限' : '∞')}</td><td><span className={`invite-status ${row.enabled ? 'on' : 'off'}`}>{row.enabled ? (zh ? '启用' : 'Active') : (zh ? '停用' : 'Disabled')}</span></td><td>{new Date(row.createdAt).toLocaleString()}</td><td><button type="button" className="ghost-btn small" onClick={async () => { await api.billing('setInviteEnabled', row.code, !row.enabled); await load() }}>{row.enabled ? (zh ? '停用' : 'Disable') : (zh ? '启用' : 'Enable')}</button></td></tr>)}</tbody>
            </table>
          </div>
        </section>

        <div className="invite-detail-grid">
          <section className="invite-panel">
            <div className="invite-panel-head"><div><h2>{zh ? '邀请用户' : 'Referred users'}</h2><p>{zh ? '邮箱已做隐私遮罩，关系建立后不可修改。' : 'Emails are masked. Referral ownership cannot be changed.'}</p></div><span className="invite-count">{data?.referrals.length ?? 0}</span></div>
            <div className="invite-table-scroll"><table className="invite-table compact"><thead><tr><th>{zh ? '用户' : 'User'}</th><th>{zh ? '邀请码' : 'Code'}</th><th>{zh ? '注册时间' : 'Registered'}</th><th>{zh ? '贡献佣金' : 'Commission'}</th></tr></thead><tbody>
              {(data?.referrals.length ?? 0) === 0 ? <tr><td colSpan={4} className="invite-empty">{zh ? '还没有邀请用户' : 'No referrals yet'}</td></tr> : data?.referrals.map((row) => <tr key={row.userId}><td>{row.email}</td><td><code>{row.inviteCode}</code></td><td>{new Date(row.registeredAt).toLocaleString()}</td><td className="invite-money">+{money(row.commissionCents)}</td></tr>)}
            </tbody></table></div>
          </section>

          <section className="invite-panel">
            <div className="invite-panel-head"><div><h2>{zh ? '返佣流水' : 'Commission ledger'}</h2><p>{zh ? '每笔返佣独立记录，比例按发生时锁定。' : 'Each commission keeps the rate active at that time.'}</p></div><span className="invite-count">{data?.commissions.length ?? 0}</span></div>
            <div className="invite-table-scroll"><table className="invite-table compact"><thead><tr><th>{zh ? '类型' : 'Type'}</th><th>{zh ? '来源用户' : 'User'}</th><th>{zh ? '计佣金额' : 'Base'}</th><th>{zh ? '比例' : 'Rate'}</th><th>{zh ? '佣金' : 'Commission'}</th><th>{zh ? '时间' : 'Time'}</th></tr></thead><tbody>
              {(data?.commissions.length ?? 0) === 0 ? <tr><td colSpan={6} className="invite-empty">{zh ? '暂无返佣流水' : 'No commission records'}</td></tr> : data?.commissions.map((row) => <tr key={row.id}><td>{row.eventType === 'topup' ? (zh ? '充值' : 'Top-up') : (zh ? '消费' : 'Spend')}</td><td>{row.inviteeEmail ?? `#${row.id}`}</td><td>{money(row.baseCents)}</td><td>{(row.rateBps / 100).toFixed(2)}%</td><td className="invite-money">+{money(row.commissionCents)}</td><td>{new Date(row.createdAt).toLocaleString()}</td></tr>)}
            </tbody></table></div>
          </section>
        </div>
      </div>
    </div>
  )
}
