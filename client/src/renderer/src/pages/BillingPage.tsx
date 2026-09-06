import { useCallback, useEffect, useState } from 'react'
import { errText } from '../errors'
import { estimatePayable, usd } from '../billing-format'
import { Markdown } from '../components/Markdown'
import { useI18n } from '../i18n'

const api = window.omni

/** 与 server/src/billing 对齐的展示子集 */
interface Plan {
  id: string
  name: string
  priceCents: number
  periodUnit: string
  periodCount: number
  maxAccounts: number
  tier: 'free' | 'vip1' | 'vip2' | 'vip3' | 'custom'
  includedCharacters: number
  description?: string
}

interface PayChannel {
  id: string
  type: string
  name: string
  currency: string
  feeRate: number
  feeFixedCents: number
  feePaidBy: 'merchant' | 'customer'
}

interface Me {
  balance: { balanceCents: number; credits: number }
  subscription: { planId: string; expiresAt: number; autoRenew: boolean; status: string } | null
  plan: Plan | null
  accountQuota: number
  membershipTier: Plan['tier']
  entitlements: { characters: number; bonusPorts: number }
  settings: { creditsPerUsd: number; charactersPerUsd: number }
}

interface OrderRow {
  id: string
  kind: string
  amountCents: number
  payableCents: number
  currency: string
  payableLocal: number
  status: string
  createdAt: number
}

interface LedgerRow {
  id: number
  kind: string
  amountCents: number
  creditsDelta: number
  balanceAfter: number
  note?: string
  createdAt: number
}

interface EntitlementLedgerRow {
  id: number
  kind: string
  charactersDelta: number
  portsDelta: number
  charactersAfter: number
  portsAfter: number
  note?: string
  createdAt: number
}

interface PaymentInfo {
  payUrl?: string
  payload?: Record<string, string>
}

/** 支付通道卡片列表：把各通道手续费亮出来，用户自己挑最划算的 */
function ChannelCards({
  channels,
  amountCents,
  selected,
  onSelect
}: {
  channels: PayChannel[]
  /** 商品金额（美分）；>0 时卡片上显示该金额下的手续费与应付 */
  amountCents: number
  selected: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="channel-grid">
      {channels.map((c) => {
        const payable = estimatePayable(c, amountCents)
        const fee = payable - amountCents
        return (
          <button
            key={c.id}
            type="button"
            className={`channel-card ${selected === c.id ? 'on' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            <span className="channel-name">{c.name}</span>
            <span className="channel-currency">{c.currency}</span>
            <span className="channel-fee">
              {c.feePaidBy === 'customer'
                ? amountCents > 0 && fee > 0
                  ? t('bill.cardFee').replace('{fee}', usd(fee))
                  : t('bill.cardFeeRate')
                      .replace('{rate}', `${(c.feeRate * 100).toFixed(1)}%`)
                      .replace('{fixed}', c.feeFixedCents > 0 ? `+${usd(c.feeFixedCents)}` : '')
                : t('bill.cardNoFee')}
            </span>
            {amountCents > 0 && c.feePaidBy === 'customer' && fee > 0 && (
              <span className="channel-payable">
                {t('bill.cardPayable').replace('{total}', usd(payable))}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** 下单结果：网页支付链接或转账 payload */
function PaymentResult({ payment }: { payment: PaymentInfo | null }): React.JSX.Element | null {
  const { t } = useI18n()
  if (!payment) return null
  return (
    <>
      {payment.payUrl && (
        <div className="link-preview">
          <code>{payment.payUrl}</code>
          <button
            type="button"
            className="primary-btn"
            onClick={() => void navigator.clipboard.writeText(payment.payUrl!)}
          >
            {t('campaign.copy')}
          </button>
        </div>
      )}
      {payment.payload && (
        <div className="pay-payload">
          {Object.entries(payment.payload).map(([k, v]) => (
            <p key={k}>
              <span className="pp-key">{k}</span> <code>{v}</code>
            </p>
          ))}
          <p className="field-hint">{t('bill.payloadHint')}</p>
        </div>
      )}
    </>
  )
}


function fmt(ts?: number): string {
  return ts ? new Date(ts).toLocaleString() : '—'
}

type Tab = 'overview' | 'plans' | 'topup' | 'usage' | 'history'
type UsageSummary = {
  totalCharacters: number
  totalTranslations: number
  byEngine: Array<{ engine: string; characters: number; calls: number }>
  byChannel: Array<{ channel: string; characters: number; calls: number }>
  recent: Array<{ userId: number; requestId: string; engine: string; channel: string; direction: string; sourceCharacters: number; createdAt: number }>
}

/**
 * 套餐与余额 —— 客户端侧的钱包页。
 *
 * 支付流程：选通道下单 → 拿到 payUrl（网页支付）或 payload（USDT 转账信息）→
 * 用户完成支付 → 后台收到回调入账 → 本页刷新看到余额。
 * 客户端自身从不接触任何支付密钥。
 */
export function BillingPage(): React.JSX.Element {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('overview')
  const [me, setMe] = useState<Me | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setErr('')
    try {
      setMe(await api.billing<Me>('me'))
    } catch (e) {
      setErr(errText(e))
    }
  }, [])

  useEffect(() => {
    // 切换页签就重新拉取：支付/补单发生在页面外（后台标记、支付回调），
    // 用户切回概览必须立刻看到新余额和套餐，而不是上次的缓存
    void load()
  }, [load, tab])

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'overview', label: t('bill.overview') },
    { id: 'plans', label: t('bill.plans') },
    { id: 'topup', label: t('bill.topup') },
    { id: 'usage', label: t('bill.characterUsage') },
    { id: 'history', label: t('bill.history') }
  ]

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('bill.title')}</h1>
        <div className="page-tabs">
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              className={tab === x.id ? 'on' : ''}
              onClick={() => setTab(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>
      </header>
      <div className="page-body">
        {err && <p className="auth-err">{err}</p>}
        {tab === 'overview' && <Overview me={me} onChanged={load} />}
        {tab === 'plans' && <PlansTab me={me} onChanged={load} />}
        {tab === 'topup' && <TopupTab onChanged={load} />}
        {tab === 'usage' && <CharacterUsageTab />}
        {tab === 'history' && <HistoryTab />}
      </div>
    </div>
  )
}

function Overview({ me, onChanged }: { me: Me | null; onChanged: () => Promise<void> }): React.JSX.Element {
  const { t } = useI18n()
  const [cents, setCents] = useState('1.00')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  if (!me) return <p className="field-hint">{t('campaign.loading')}</p>

  return (
    <div className="form-page">
      <div className="stat-cards">
        <div className="stat-card">
          <span className="k">{t('bill.balance')}</span>
          <span className="v">{usd(me.balance.balanceCents)}</span>
        </div>
        <div className="stat-card">
          <span className="k">{t('bill.characters')}</span>
          <span className="v">{me.entitlements.characters.toLocaleString()}</span>
        </div>
        <div className="stat-card">
          <span className="k">{t('bill.accountQuota')}</span>
          <span className="v">{me.accountQuota === 0 ? t('bill.unlimited') : me.accountQuota}</span>
        </div>
      </div>

      <section className="form-card">
        <h3>{t('bill.currentPlan')}</h3>
        {me.subscription && me.plan ? (
          <>
            <p>
              <strong>{me.plan.name}</strong> · {usd(me.plan.priceCents)} ·{' '}
              {t('bill.maxAccounts')} {me.plan.maxAccounts === 0 ? t('bill.unlimited') : me.plan.maxAccounts} ·{' '}
              {me.subscription.status === 'active'
                ? `${fmt(me.subscription.expiresAt)} ${t('bill.expires')}`
                : t('bill.expired')}
            </p>
            <label className="field checkbox">
              <input
                type="checkbox"
                checked={me.subscription.autoRenew}
                onChange={async (e) => {
                  await api.billing('setAutoRenew', e.target.checked)
                  await onChanged()
                }}
              />
              <span>{t('bill.autoRenew')}</span>
            </label>
            <p className="field-hint">{t('bill.autoRenewHint')}</p>
          </>
        ) : (
          <p className="field-hint">{t('bill.noPlan')}</p>
        )}
      </section>

      <section className="form-card">
        <h3>{t('bill.exchange')}</h3>
        <p className="field-hint">
          {t('bill.exchangeHint').replace('{n}', String(me.settings.charactersPerUsd))}
        </p>
        <div className="field-row">
          <label className="field">
            <span>{t('bill.amountUsd')}</span>
            <input type="text" value={cents} onChange={(e) => setCents(e.target.value)} />
          </label>
          <button
            type="button"
            className="primary-btn"
            disabled={busy}
            onClick={async () => {
              setMsg('')
              const v = Math.round(Number(cents) * 100)
              if (!Number.isFinite(v) || v < 1) return setMsg(t('bill.errAmount'))
              setBusy(true)
              try {
                await api.billing('exchangeCharacters', v)
                setMsg(t('bill.exchanged'))
                await onChanged()
              } catch (e) {
                setMsg(errText(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('bill.doExchange')}
          </button>
        </div>
        {msg && <p className="field-hint ok">{msg}</p>}
      </section>
    </div>
  )
}

function PlansTab({ me, onChanged }: { me: Me | null; onChanged: () => Promise<void> }): React.JSX.Element {
  const { t } = useI18n()
  const [plans, setPlans] = useState<Plan[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  /** 余额不足时进入的直付面板：选通道给这个套餐下单 */
  const [payPlan, setPayPlan] = useState<Plan | null>(null)

  useEffect(() => {
    void api.billing<{ plans: Plan[] }>('listPlans').then((r) => setPlans(r.plans))
  }, [])

  const unitLabel = (p: Plan): string => {
    const unit = t(`bill.unit.${p.periodUnit}` as 'bill.unit.month')
    return p.periodCount > 1 ? `${p.periodCount} ${unit}` : unit
  }

  if (payPlan) {
    return (
      <PlanPayPanel
        plan={payPlan}
        onBack={() => setPayPlan(null)}
        onChanged={onChanged}
      />
    )
  }

  return (
    <div className="form-page">
      <p className="field-hint">{t('bill.plansHint')}</p>
      {msg && <p className="auth-err">{msg}</p>}
      <div className="plan-grid">
        {plans.map((p) => {
          const current = me?.subscription?.planId === p.id && me?.subscription?.status === 'active'
          return (
            <div key={p.id} className={`plan-card ${current ? 'current' : ''}`}>
              <h3>{p.name}</h3>
              <div className="plan-price">
                {usd(p.priceCents)}
                <span className="plan-unit">/ {unitLabel(p)}</span>
              </div>
              <p className="field-hint">
                {t('bill.level')} {p.tier === 'free' ? t('bill.free') : p.tier.toUpperCase()} · {t('bill.maxAccounts')} {p.maxAccounts === 0 ? t('bill.unlimited') : p.maxAccounts}
              </p>
              {p.includedCharacters > 0 && <p className="field-hint">{t('bill.includedCharacters').replace('{n}', p.includedCharacters.toLocaleString())}</p>}
              {p.description ? <Markdown text={p.description} /> : null}
              <button
                type="button"
                className="primary-btn"
                disabled={current || busy === p.id}
                onClick={async () => {
                  setMsg('')
                  setBusy(p.id)
                  try {
                    await api.billing('subscribe', p.id)
                    await onChanged()
                  } catch (e) {
                    const m = errText(e)
                    // 余额不足 → 不弹错误，直接进入付款流程
                    if (m.includes('余额不足')) setPayPlan(p)
                    else setMsg(m)
                  } finally {
                    setBusy('')
                  }
                }}
              >
                {current ? t('bill.currentPlanBadge') : t('bill.subscribe')}
              </button>
            </div>
          )
        })}
      </div>
      <p className="field-hint">{t('bill.prorationHint')}</p>
    </div>
  )
}

function CharacterUsageTab(): React.JSX.Element {
  const { t } = useI18n()
  const [data, setData] = useState<{ entitlements: { characters: number }; summary: UsageSummary } | null>(null)
  useEffect(() => { void api.billing<NonNullable<typeof data>>('translationUsage').then(setData) }, [])
  if (!data) return <p className="field-hint">{t('campaign.loading')}</p>
  return <div className="form-page">
    <div className="stat-cards">
      <div className="stat-card"><span className="k">{t('bill.remainingCharacters')}</span><span className="v">{data.entitlements.characters.toLocaleString()}</span></div>
      <div className="stat-card"><span className="k">{t('bill.usedCharacters')}</span><span className="v">{data.summary.totalCharacters.toLocaleString()}</span></div>
      <div className="stat-card"><span className="k">{t('bill.translationCount')}</span><span className="v">{data.summary.totalTranslations.toLocaleString()}</span></div>
    </div>
    <section className="form-card"><h3>{t('bill.usageByPlatform')}</h3><table className="data-table"><thead><tr><th>{t('bill.platform')}</th><th className="num">{t('bill.translationCount')}</th><th className="num">{t('bill.usedCharacters')}</th></tr></thead><tbody>{data.summary.byChannel.map((row) => <tr key={row.channel}><td>{row.channel || '—'}</td><td className="num">{row.calls}</td><td className="num">{row.characters.toLocaleString()}</td></tr>)}</tbody></table></section>
    <section className="form-card"><h3>{t('bill.recentUsage')}</h3><table className="data-table"><thead><tr><th>{t('bill.time')}</th><th>{t('bill.platform')}</th><th>{t('bill.engine')}</th><th>{t('bill.direction')}</th><th className="num">{t('bill.characters')}</th></tr></thead><tbody>{data.summary.recent.map((row) => <tr key={`${row.userId}:${row.requestId}`}><td>{fmt(row.createdAt)}</td><td>{row.channel || '—'}</td><td>{row.engine}</td><td>{row.direction === 'in' ? t('bill.inbound') : t('bill.outbound')}</td><td className="num">{row.sourceCharacters.toLocaleString()}</td></tr>)}</tbody></table></section>
  </div>
}

/** 套餐直付：余额不够时不绕充值，直接对套餐下单付款 */
function PlanPayPanel({
  plan,
  onBack,
  onChanged
}: {
  plan: Plan
  onBack: () => void
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()
  const [channels, setChannels] = useState<PayChannel[]>([])
  const [channelId, setChannelId] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [payment, setPayment] = useState<PaymentInfo | null>(null)

  useEffect(() => {
    void api.billing<{ channels: PayChannel[] }>('listChannels').then((r) => {
      setChannels(r.channels)
      if (r.channels[0]) setChannelId(r.channels[0].id)
    })
  }, [])

  return (
    <div className="form-page">
      <section className="form-card">
        <div className="page-toolbar">
          <button type="button" className="ghost-btn" onClick={onBack}>
            ← {t('bill.backToPlans')}
          </button>
        </div>
        <h3>{t('bill.payForPlan').replace('{plan}', `${plan.name} ${usd(plan.priceCents)}`)}</h3>
        <p className="field-hint">{t('bill.payForPlanHint')}</p>
        {channels.length === 0 ? (
          <p className="field-hint">{t('bill.noChannels')}</p>
        ) : (
          <>
            <ChannelCards
              channels={channels}
              amountCents={plan.priceCents}
              selected={channelId}
              onSelect={setChannelId}
            />
            {err && <p className="auth-err">{err}</p>}
            <button
              type="button"
              className="primary-btn"
              disabled={busy || !channelId}
              onClick={async () => {
                setErr('')
                setPayment(null)
                setBusy(true)
                try {
                  const r = await api.billing<{ payment: PaymentInfo }>('createOrder', {
                    kind: 'plan',
                    planId: plan.id,
                    channelId
                  })
                  setPayment(r.payment)
                  await onChanged()
                } catch (e) {
                  setErr(errText(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t('bill.createOrder')}
            </button>
          </>
        )}
        <PaymentResult payment={payment} />
      </section>
    </div>
  )
}

function TopupTab({ onChanged }: { onChanged: () => Promise<void> }): React.JSX.Element {
  const { t } = useI18n()
  const [channels, setChannels] = useState<PayChannel[]>([])
  const [channelId, setChannelId] = useState('')
  const [amount, setAmount] = useState('10.00')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [payment, setPayment] = useState<PaymentInfo | null>(null)

  useEffect(() => {
    void api.billing<{ channels: PayChannel[] }>('listChannels').then((r) => {
      setChannels(r.channels)
      if (r.channels[0]) setChannelId(r.channels[0].id)
    })
  }, [])

  const channel = channels.find((c) => c.id === channelId)
  const amountCents = Math.round(Number(amount) * 100)
  // 客户承担手续费时预估应付（gross-up 口径与后端一致，含费率钳制，仅作展示）
  const estimate = channel ? estimatePayable(channel, amountCents) : amountCents

  return (
    <div className="form-page">
      <section className="form-card">
        <h3>{t('bill.topup')}</h3>
        {channels.length === 0 ? (
          <p className="field-hint">{t('bill.noChannels')}</p>
        ) : (
          <>
            <label className="field">
              <span>{t('bill.amountUsd')}</span>
              <input type="text" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <div className="field">
              <span>{t('bill.channel')}</span>
              <ChannelCards
                channels={channels}
                amountCents={Number.isFinite(amountCents) ? amountCents : 0}
                selected={channelId}
                onSelect={setChannelId}
              />
            </div>
            {channel && channel.feePaidBy === 'customer' && Number.isFinite(estimate) && estimate > amountCents && (
              <p className="field-hint">
                {t('bill.feeEstimate')
                  .replace('{fee}', usd(estimate - amountCents))
                  .replace('{total}', usd(estimate))}
              </p>
            )}
            {err && <p className="auth-err">{err}</p>}
            <button
              type="button"
              className="primary-btn"
              disabled={busy}
              onClick={async () => {
                setErr('')
                setPayment(null)
                if (!Number.isFinite(amountCents) || amountCents < 100) {
                  return setErr(t('bill.errMin'))
                }
                setBusy(true)
                try {
                  const r = await api.billing<{ payment: PaymentInfo }>('createOrder', {
                    kind: 'topup',
                    amountCents,
                    channelId
                  })
                  setPayment(r.payment)
                  await onChanged()
                } catch (e) {
                  setErr(errText(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t('bill.createOrder')}
            </button>
          </>
        )}

        <PaymentResult payment={payment} />
      </section>
    </div>
  )
}

function HistoryTab(): React.JSX.Element {
  const { t } = useI18n()
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [entitlementLedger, setEntitlementLedger] = useState<EntitlementLedgerRow[]>([])

  useEffect(() => {
    void api.billing<{ orders: OrderRow[] }>('listOrders').then((r) => setOrders(r.orders))
    void api.billing<{ ledger: LedgerRow[]; entitlementLedger: EntitlementLedgerRow[] }>('listLedger').then((r) => { setLedger(r.ledger); setEntitlementLedger(r.entitlementLedger ?? []) })
  }, [])

  return (
    <div className="form-page">
      <section className="form-card">
        <h3>{t('bill.orders')}</h3>
        {orders.length === 0 ? (
          <p className="empty-hint">{t('form.noOptions')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('bill.time')}</th>
                <th className="num">{t('bill.amount')}</th>
                <th className="num">{t('bill.payable')}</th>
                <th>{t('bill.status')}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{fmt(o.createdAt)}</td>
                  <td className="num">{usd(o.amountCents)}</td>
                  <td className="num">{usd(o.payableCents)}</td>
                  <td>{t(`bill.status.${o.status}` as 'bill.status.pending')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="form-card">
        <h3>{t('bill.ledger')}</h3>
        {ledger.length === 0 ? (
          <p className="empty-hint">{t('form.noOptions')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('bill.time')}</th>
                <th>{t('bill.kind')}</th>
                <th className="num">{t('bill.amount')}</th>
                <th className="num">{t('bill.credits')}</th>
                <th className="num">{t('bill.balanceAfter')}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.id}>
                  <td>{fmt(l.createdAt)}</td>
                  <td>{t(`bill.kind.${l.kind}` as 'bill.kind.topup')}</td>
                  <td className="num">{l.amountCents !== 0 ? usd(l.amountCents) : '—'}</td>
                  <td className="num">{l.creditsDelta !== 0 ? l.creditsDelta : '—'}</td>
                  <td className="num">{usd(l.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="form-card">
        <h3>{t('bill.characterLedger')}</h3>
        {entitlementLedger.length === 0 ? <p className="empty-hint">{t('form.noOptions')}</p> : <table className="data-table"><thead><tr><th>{t('bill.time')}</th><th>{t('bill.kind')}</th><th className="num">{t('bill.characters')}</th><th className="num">{t('bill.accountQuota')}</th><th className="num">{t('bill.remainingCharacters')}</th><th>{t('bill.note')}</th></tr></thead><tbody>{entitlementLedger.map((row) => <tr key={row.id}><td>{fmt(row.createdAt)}</td><td>{row.kind}</td><td className="num">{row.charactersDelta || '—'}</td><td className="num">{row.portsDelta || '—'}</td><td className="num">{row.charactersAfter.toLocaleString()}</td><td>{row.note || '—'}</td></tr>)}</tbody></table>}
      </section>
    </div>
  )
}
