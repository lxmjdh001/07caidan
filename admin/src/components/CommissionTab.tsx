import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AdminInviteOverview, ApiClient } from '../api'
import { useI18n } from '../i18n'

function money(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`
}

export function CommissionTab({ client }: { client: ApiClient }): React.JSX.Element {
  const { locale } = useI18n()
  const zh = locale.startsWith('zh')
  const [data, setData] = useState<AdminInviteOverview | null>(null)
  const [rate, setRate] = useState('0')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const next = await client.inviteOverview()
      setData(next)
      setRate((next.rateBps / 100).toFixed(2))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }, [client])

  useEffect(() => { void load() }, [load])

  const totals = useMemo(() => ({
    paid: data?.totalCommissionCents ?? 0,
    inviters: new Set(data?.codes.map((row) => row.inviterUserId) ?? []).size
  }), [data])

  const save = async (): Promise<void> => {
    const value = Number(rate)
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      setError(zh ? '比例必须在 0% 到 100% 之间' : 'Rate must be between 0% and 100%')
      return
    }
    setBusy(true)
    setMessage('')
    setError('')
    try {
      await client.updateCommissionRate(value)
      setMessage(zh ? '返佣比例已生效；历史流水比例保持不变。' : 'Commission rate updated. Historical records remain unchanged.')
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <>
    <section className="card commission-setting-card">
      <div>
        <h3>{zh ? '全局返佣比例' : 'Global commission rate'}</h3>
        <p className="muted small">{zh ? '同一比例同时用于被邀请用户的每次充值与所有实际消费。设为 0 即暂停新增返佣。' : 'The same rate applies to every referred-user top-up and actual purchase. Set to zero to pause new commissions.'}</p>
      </div>
      <div className="commission-rate-control"><input type="number" min="0" max="100" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /><span>%</span><button className="primary" disabled={busy} onClick={() => void save()}>{busy ? '…' : (zh ? '保存比例' : 'Save rate')}</button></div>
      {message && <p className="ok">{message}</p>}
      {error && <p className="err">{error}</p>}
    </section>

    <div className="commission-summary">
      <section className="card"><span>{zh ? '邀请人' : 'Inviters'}</span><strong>{totals.inviters}</strong></section>
      <section className="card"><span>{zh ? '已邀请用户' : 'Referred users'}</span><strong>{data?.referrals.length ?? 0}</strong></section>
      <section className="card"><span>{zh ? '累计发放佣金' : 'Commission paid'}</span><strong>{money(totals.paid)}</strong></section>
    </div>

    <section className="card">
      <h3>{zh ? '邀请关系' : 'Referral relationships'}</h3>
      <div className="admin-table-scroll"><table className="data-table"><thead><tr><th>{zh ? '邀请人' : 'Inviter'}</th><th>{zh ? '被邀请账号' : 'Referred account'}</th><th>{zh ? '邀请码' : 'Code'}</th><th>{zh ? '注册时间' : 'Registered'}</th><th className="num">{zh ? '贡献佣金' : 'Commission'}</th></tr></thead><tbody>
        {(data?.referrals.length ?? 0) === 0 ? <tr><td colSpan={5} className="muted">{zh ? '暂无邀请关系' : 'No referrals'}</td></tr> : data?.referrals.map((row) => <tr key={row.userId}><td>{row.inviterEmail ?? `#${row.inviterUserId}`}</td><td>{row.email}</td><td><code>{row.inviteCode}</code></td><td>{new Date(row.registeredAt).toLocaleString()}</td><td className="num ok">+{money(row.commissionCents)}</td></tr>)}
      </tbody></table></div>
    </section>

    <section className="card">
      <h3>{zh ? '返佣流水' : 'Commission ledger'}</h3>
      <div className="admin-table-scroll"><table className="data-table"><thead><tr><th>{zh ? '邀请人' : 'Inviter'}</th><th>{zh ? '来源用户' : 'Source user'}</th><th>{zh ? '类型' : 'Type'}</th><th className="num">{zh ? '计佣金额' : 'Base'}</th><th className="num">{zh ? '比例' : 'Rate'}</th><th className="num">{zh ? '佣金' : 'Commission'}</th><th>{zh ? '时间' : 'Time'}</th></tr></thead><tbody>
        {(data?.commissions.length ?? 0) === 0 ? <tr><td colSpan={7} className="muted">{zh ? '暂无返佣流水' : 'No commission records'}</td></tr> : data?.commissions.map((row) => <tr key={row.id}><td>{row.inviterEmail ?? `#${row.inviterUserId}`}</td><td>{row.inviteeEmail ?? `#${row.inviteeUserId}`}</td><td>{row.eventType === 'topup' ? (zh ? '充值' : 'Top-up') : (zh ? '消费' : 'Spend')}</td><td className="num">{money(row.baseCents)}</td><td className="num">{(row.rateBps / 100).toFixed(2)}%</td><td className="num ok">+{money(row.commissionCents)}</td><td>{new Date(row.createdAt).toLocaleString()}</td></tr>)}
      </tbody></table></div>
    </section>
  </>
}
