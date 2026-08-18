import { useCallback, useEffect, useState } from 'react'
import type {
  AdminOrder,
  AiModelRow,
  AiProvider,
  ApiClient,
  ExRate,
  PayChannel,
  Plan
} from '../api'
import { useI18n } from '../i18n'

interface Props {
  client: ApiClient
}

type Tab = 'plans' | 'channels' | 'rates' | 'ai' | 'usage' | 'orders'

/** 美分 → 美元展示 */
function usd(cents: number): string {
  const abs = Math.abs(Math.round(cents))
  return `$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** 美元输入串 → 美分；非法返回 null */
function parseUsd(v: string): number | null {
  const cleaned = v.trim().replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const [i, d = ''] = cleaned.split('.')
  return Number(i) * 100 + Number(d.padEnd(2, '0'))
}

/**
 * 计费管理：套餐 / 支付通道 / 汇率 / AI 模型 / 用量报表。
 * 编辑一律走「行内表单 + 保存」，不做复杂弹窗 —— 这些是低频运营操作。
 */
export function BillingView({ client }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('plans')

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'plans', label: t('billing.plans') },
    { id: 'channels', label: t('billing.channels') },
    { id: 'rates', label: t('billing.rates') },
    { id: 'ai', label: t('billing.ai') },
    { id: 'usage', label: t('billing.usage') },
    { id: 'orders', label: t('billing.orders') }
  ]

  return (
    <div className="view">
      <header className="view-header">
        <h1>{t('billing.title')}</h1>
        <div className="seg-tabs">
          {TABS.map((x) => (
            <button
              key={x.id}
              className={tab === x.id ? 'on' : ''}
              onClick={() => setTab(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>
      </header>
      <div className="view-body">
        {tab === 'plans' && <PlansTab client={client} />}
        {tab === 'channels' && <ChannelsTab client={client} />}
        {tab === 'rates' && <RatesTab client={client} />}
        {tab === 'ai' && <AiTab client={client} />}
        {tab === 'usage' && <UsageTab client={client} />}
        {tab === 'orders' && <OrdersTab client={client} />}
      </div>
    </div>
  )
}

// ══════════ 套餐 ══════════

const PERIOD_UNITS = ['month', 'quarter', 'half_year', 'year', 'day'] as const

function PlansTab({ client }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [plans, setPlans] = useState<Plan[]>([])
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [price, setPrice] = useState('9.90')
  const [unit, setUnit] = useState<string>('month')
  const [count, setCount] = useState('1')
  const [maxAccounts, setMaxAccounts] = useState('10')
  const [desc, setDesc] = useState('')

  const load = useCallback(async () => {
    try {
      setPlans((await client.listPlans()).plans)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (): Promise<void> => {
    setErr('')
    const cents = parseUsd(price)
    if (!name.trim()) return setErr(t('billing.errName'))
    if (cents === null) return setErr(t('billing.errPrice'))
    await client.createPlan({
      name: name.trim(),
      priceCents: cents,
      periodUnit: unit as Plan['periodUnit'],
      periodCount: Number(count) || 1,
      maxAccounts: Number(maxAccounts) || 1,
      description: desc
    })
    setName('')
    setDesc('')
    await load()
  }

  return (
    <>
      <section className="card">
        <h3>{t('billing.newPlan')}</h3>
        <div className="form-row">
          <label>
            <span>{t('billing.planName')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>{t('billing.priceUsd')}</span>
            <input value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <label>
            <span>{t('billing.period')}</span>
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {PERIOD_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`billing.unit.${u}` as 'billing.unit.month')}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('billing.periodCount')}</span>
            <input value={count} onChange={(e) => setCount(e.target.value)} style={{ width: 70 }} />
          </label>
          <label>
            <span>{t('billing.maxAccounts')}</span>
            <input
              value={maxAccounts}
              onChange={(e) => setMaxAccounts(e.target.value)}
              style={{ width: 70 }}
            />
          </label>
          <button className="primary" onClick={() => void create()}>
            {t('billing.create')}
          </button>
        </div>
        <label className="block-label">
          <span>{t('billing.planDesc')}</span>
          <textarea
            rows={4}
            value={desc}
            placeholder={t('billing.planDescHint')}
            onChange={(e) => setDesc(e.target.value)}
          />
        </label>
        {err && <p className="err">{err}</p>}
      </section>

      <section className="card">
        <h3>{t('billing.plans')}</h3>
        {plans.length === 0 ? (
          <p className="muted small">{t('common.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('billing.planName')}</th>
                <th className="num">{t('billing.priceUsd')}</th>
                <th>{t('billing.period')}</th>
                <th className="num">{t('billing.maxAccounts')}</th>
                <th>{t('billing.planDesc')}</th>
                <th>{t('billing.enabled')}</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} className={p.enabled ? '' : 'row-off'}>
                  <td>{p.name}</td>
                  <td className="num">{usd(p.priceCents)}</td>
                  <td>
                    {p.periodCount > 1 ? `${p.periodCount} × ` : ''}
                    {t(`billing.unit.${p.periodUnit}` as 'billing.unit.month')}
                  </td>
                  <td className="num">{p.maxAccounts}</td>
                  <td className="desc-cell" title={p.description || ''}>
                    <span>{(p.description || '').slice(0, 40) || '—'}</span>
                    <button
                      className="ghost small"
                      onClick={async () => {
                        const next = window.prompt(t('billing.planDescPrompt'), p.description || '')
                        if (next === null) return
                        await client.updatePlan(p.id, { description: next })
                        await load()
                      }}
                    >
                      {t('common.edit')}
                    </button>
                  </td>
                  <td>
                    <button
                      className="ghost small"
                      onClick={async () => {
                        await client.updatePlan(p.id, { enabled: !p.enabled })
                        await load()
                      }}
                    >
                      {p.enabled ? t('billing.disable') : t('billing.enable')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

// ══════════ 支付通道 ══════════

/** 各通道类型需要的配置键与提示 */
const CHANNEL_CONFIG_KEYS: Record<string, Array<{ key: string; label: string }>> = {
  yipay: [
    { key: 'endpoint', label: '网关地址' },
    { key: 'pid', label: '商户 PID' },
    { key: 'key', label: '商户密钥' },
    { key: 'payType', label: '支付方式(alipay/wxpay)' }
  ],
  paypal: [
    { key: 'clientId', label: 'Client ID' },
    { key: 'clientSecret', label: 'Client Secret' },
    { key: 'webhookId', label: 'Webhook ID' },
    { key: 'mode', label: 'live / sandbox' }
  ],
  usdt: [
    { key: 'network', label: '网络(TRC20/ERC20)' },
    { key: 'address', label: '收款地址' },
    { key: 'callbackSecret', label: '回调密钥' },
    { key: 'minConfirmations', label: '最少确认数' }
  ],
  mock: [{ key: 'callbackSecret', label: '回调密钥' }]
}

function ChannelsTab({ client }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [channels, setChannels] = useState<PayChannel[]>([])
  const [err, setErr] = useState('')
  const [type, setType] = useState<string>('yipay')
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [feeRate, setFeeRate] = useState('0')
  const [feeFixed, setFeeFixed] = useState('0')
  const [feePaidBy, setFeePaidBy] = useState<'merchant' | 'customer'>('merchant')
  const [config, setConfig] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      setChannels((await client.listChannels()).channels)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (): Promise<void> => {
    setErr('')
    if (!name.trim()) return setErr(t('billing.errName'))
    const rate = Number(feeRate)
    await client.createChannel({
      type: type as PayChannel['type'],
      name: name.trim(),
      currency,
      // 输入的是百分比（2.4），存的是小数（0.024）
      feeRate: Number.isFinite(rate) ? rate / 100 : 0,
      feeFixedCents: parseUsd(feeFixed) ?? 0,
      feePaidBy,
      config
    })
    setName('')
    setConfig({})
    await load()
  }

  return (
    <>
      <section className="card">
        <h3>{t('billing.newChannel')}</h3>
        <div className="form-row">
          <label>
            <span>{t('billing.channelType')}</span>
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value)
                setConfig({})
              }}
            >
              {Object.keys(CHANNEL_CONFIG_KEYS).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('billing.channelName')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>{t('billing.currency')}</span>
            <input value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ width: 70 }} />
          </label>
          <label>
            <span>{t('billing.feeRatePct')}</span>
            <input value={feeRate} onChange={(e) => setFeeRate(e.target.value)} style={{ width: 70 }} />
          </label>
          <label>
            <span>{t('billing.feeFixedUsd')}</span>
            <input value={feeFixed} onChange={(e) => setFeeFixed(e.target.value)} style={{ width: 70 }} />
          </label>
          <label>
            <span>{t('billing.feePaidBy')}</span>
            <select
              value={feePaidBy}
              onChange={(e) => setFeePaidBy(e.target.value as 'merchant' | 'customer')}
            >
              <option value="merchant">{t('billing.feeMerchant')}</option>
              <option value="customer">{t('billing.feeCustomer')}</option>
            </select>
          </label>
        </div>
        <div className="form-row">
          {(CHANNEL_CONFIG_KEYS[type] ?? []).map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <input
                value={config[f.key] ?? ''}
                onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
              />
            </label>
          ))}
          <button className="primary" onClick={() => void create()}>
            {t('billing.create')}
          </button>
        </div>
        <p className="muted small">{t('billing.feeHint')}</p>
        {err && <p className="err">{err}</p>}
      </section>

      <section className="card">
        <h3>{t('billing.channels')}</h3>
        {channels.length === 0 ? (
          <p className="muted small">{t('common.empty')}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('billing.channelName')}</th>
                <th>{t('billing.channelType')}</th>
                <th>{t('billing.currency')}</th>
                <th className="num">{t('billing.fee')}</th>
                <th>{t('billing.feePaidBy')}</th>
                <th>{t('users.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id} className={c.enabled ? '' : 'row-off'}>
                  <td>{c.name}</td>
                  <td>{c.type}</td>
                  <td>{c.currency}</td>
                  <td className="num">
                    {(c.feeRate * 100).toFixed(2)}% + {usd(c.feeFixedCents)}
                  </td>
                  <td>{c.feePaidBy === 'customer' ? t('billing.feeCustomer') : t('billing.feeMerchant')}</td>
                  <td>
                    <button
                      className="ghost small"
                      onClick={async () => {
                        await client.updateChannel(c.id, { enabled: !c.enabled })
                        await load()
                      }}
                    >
                      {c.enabled ? t('billing.disable') : t('billing.enable')}
                    </button>{' '}
                    <button
                      className="danger small"
                      onClick={async () => {
                        if (!window.confirm(t('billing.deleteChannelConfirm'))) return
                        await client.deleteChannel(c.id)
                        await load()
                      }}
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

// ══════════ 汇率 ══════════

function RatesTab({ client }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [rates, setRates] = useState<ExRate[]>([])
  const [currency, setCurrency] = useState('CNY')
  const [rate, setRate] = useState('7.2')
  const [decimals, setDecimals] = useState('2')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      setRates((await client.listRates()).rates)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="card">
      <h3>{t('billing.rates')}</h3>
      <p className="muted small">{t('billing.ratesHint')}</p>
      <div className="form-row">
        <label>
          <span>{t('billing.currency')}</span>
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ width: 80 }} />
        </label>
        <label>
          <span>{t('billing.rateValue')}</span>
          <input value={rate} onChange={(e) => setRate(e.target.value)} style={{ width: 100 }} />
        </label>
        <label>
          <span>{t('billing.decimals')}</span>
          <input value={decimals} onChange={(e) => setDecimals(e.target.value)} style={{ width: 60 }} />
        </label>
        <button
          className="primary"
          onClick={async () => {
            setErr('')
            const r = Number(rate)
            if (!Number.isFinite(r) || r <= 0) return setErr(t('billing.errRate'))
            await client.setRate(currency.trim().toUpperCase(), r, Number(decimals) || 2)
            await load()
          }}
        >
          {t('common.save')}
        </button>
      </div>
      {err && <p className="err">{err}</p>}
      {rates.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('billing.currency')}</th>
              <th className="num">{t('billing.rateValue')}</th>
              <th className="num">{t('billing.decimals')}</th>
              <th>{t('users.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((r) => (
              <tr key={r.currency}>
                <td>{r.currency}</td>
                <td className="num">{r.rate}</td>
                <td className="num">{r.decimals}</td>
                <td>
                  <button
                    className="danger small"
                    onClick={async () => {
                      await client.deleteRate(r.currency)
                      await load()
                    }}
                  >
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

// ══════════ AI 供应商与模型 ══════════

const PROVIDER_TYPES = ['openai', 'anthropic', 'openrouter', 'openai_compatible']
const PURPOSES = ['asr', 'translate', 'autoreply']

function AiTab({ client }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [models, setModels] = useState<AiModelRow[]>([])
  const [settings, setSettings] = useState({ creditsPerUsd: 1000, autoTopUpCredits: true })
  const [err, setErr] = useState('')

  const [pType, setPType] = useState('openai')
  const [pName, setPName] = useState('')
  const [pBaseUrl, setPBaseUrl] = useState('')
  const [pKey, setPKey] = useState('')

  const [mProvider, setMProvider] = useState('')
  const [mName, setMName] = useState('')
  const [mPurposes, setMPurposes] = useState<string[]>(['translate'])
  const [mIn, setMIn] = useState('300')
  const [mOut, setMOut] = useState('1500')
  const [mAudio, setMAudio] = useState('0')

  const load = useCallback(async () => {
    try {
      const [p, m, s] = await Promise.all([
        client.listAiProviders(),
        client.listAiModels(),
        client.billingSettings()
      ])
      setProviders(p.providers)
      setModels(m.models)
      setSettings(s.settings)
      if (!mProvider && p.providers[0]) setMProvider(p.providers[0].id)
    } catch (e) {
      setErr((e as Error).message)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      <section className="card">
        <h3>{t('billing.settings')}</h3>
        <div className="form-row">
          <label>
            <span>{t('billing.creditsPerUsd')}</span>
            <input
              value={String(settings.creditsPerUsd)}
              onChange={(e) =>
                setSettings((s) => ({ ...s, creditsPerUsd: Number(e.target.value) || 1 }))
              }
              style={{ width: 100 }}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.autoTopUpCredits}
              onChange={(e) => setSettings((s) => ({ ...s, autoTopUpCredits: e.target.checked }))}
            />
            <span>{t('billing.autoTopUp')}</span>
          </label>
          <button
            className="primary"
            onClick={async () => {
              await client.updateBillingSettings(settings)
              await load()
            }}
          >
            {t('common.save')}
          </button>
        </div>
      </section>

      <section className="card">
        <h3>{t('billing.newProvider')}</h3>
        <div className="form-row">
          <label>
            <span>{t('billing.providerType')}</span>
            <select value={pType} onChange={(e) => setPType(e.target.value)}>
              {PROVIDER_TYPES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('billing.providerName')}</span>
            <input value={pName} onChange={(e) => setPName(e.target.value)} />
          </label>
          <label>
            <span>Base URL</span>
            <input
              value={pBaseUrl}
              placeholder={t('billing.baseUrlHint')}
              onChange={(e) => setPBaseUrl(e.target.value)}
            />
          </label>
          <label>
            <span>API Key</span>
            <input type="password" value={pKey} onChange={(e) => setPKey(e.target.value)} />
          </label>
          <button
            className="primary"
            onClick={async () => {
              setErr('')
              if (!pName.trim()) return setErr(t('billing.errName'))
              await client.createAiProvider({
                type: pType as AiProvider['type'],
                name: pName.trim(),
                baseUrl: pBaseUrl.trim(),
                apiKey: pKey
              })
              setPName('')
              setPKey('')
              await load()
            }}
          >
            {t('billing.create')}
          </button>
        </div>
        {err && <p className="err">{err}</p>}
        {providers.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('billing.providerName')}</th>
                <th>{t('billing.providerType')}</th>
                <th>API Key</th>
                <th>{t('users.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id} className={p.enabled ? '' : 'row-off'}>
                  <td>{p.name}</td>
                  <td>{p.type}</td>
                  <td>
                    <code>{p.apiKeyMasked || '—'}</code>
                  </td>
                  <td>
                    <button
                      className="ghost small"
                      onClick={async () => {
                        await client.updateAiProvider(p.id, { enabled: !p.enabled })
                        await load()
                      }}
                    >
                      {p.enabled ? t('billing.disable') : t('billing.enable')}
                    </button>{' '}
                    <button
                      className="danger small"
                      onClick={async () => {
                        if (!window.confirm(t('billing.deleteProviderConfirm'))) return
                        await client.deleteAiProvider(p.id)
                        await load()
                      }}
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3>{t('billing.newModel')}</h3>
        {providers.length === 0 ? (
          <p className="muted small">{t('billing.needProviderFirst')}</p>
        ) : (
          <div className="form-row">
            <label>
              <span>{t('billing.provider')}</span>
              <select value={mProvider} onChange={(e) => setMProvider(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t('billing.modelName')}</span>
              <input value={mName} onChange={(e) => setMName(e.target.value)} />
            </label>
            <label>
              <span>{t('billing.purposes')}</span>
              <span className="check-row">
                {PURPOSES.map((x) => (
                  <label key={x} className="check">
                    <input
                      type="checkbox"
                      checked={mPurposes.includes(x)}
                      onChange={() =>
                        setMPurposes((cur) =>
                          cur.includes(x) ? cur.filter((y) => y !== x) : [...cur, x]
                        )
                      }
                    />
                    <span>{t(`billing.purpose.${x}` as 'billing.purpose.asr')}</span>
                  </label>
                ))}
              </span>
            </label>
            <label>
              <span>{t('billing.creditsIn')}</span>
              <input value={mIn} onChange={(e) => setMIn(e.target.value)} style={{ width: 80 }} />
            </label>
            <label>
              <span>{t('billing.creditsOut')}</span>
              <input value={mOut} onChange={(e) => setMOut(e.target.value)} style={{ width: 80 }} />
            </label>
            <label>
              <span>{t('billing.creditsAudio')}</span>
              <input value={mAudio} onChange={(e) => setMAudio(e.target.value)} style={{ width: 80 }} />
            </label>
            <button
              className="primary"
              onClick={async () => {
                setErr('')
                if (!mName.trim()) return setErr(t('billing.errName'))
                await client.createAiModel({
                  providerId: mProvider,
                  modelName: mName.trim(),
                  purposes: mPurposes,
                  creditsPerMillionInput: Number(mIn) || 0,
                  creditsPerMillionOutput: Number(mOut) || 0,
                  creditsPerAudioSecond: Number(mAudio) || 0
                })
                setMName('')
                await load()
              }}
            >
              {t('billing.create')}
            </button>
          </div>
        )}
        {models.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('billing.modelName')}</th>
                <th>{t('billing.purposes')}</th>
                <th className="num">{t('billing.creditsIn')}</th>
                <th className="num">{t('billing.creditsOut')}</th>
                <th className="num">{t('billing.creditsAudio')}</th>
                <th>{t('users.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id} className={m.enabled ? '' : 'row-off'}>
                  <td>{m.label || m.modelName}</td>
                  <td>
                    {m.purposes
                      .map((x) => t(`billing.purpose.${x}` as 'billing.purpose.asr'))
                      .join(' / ')}
                  </td>
                  <td className="num">{m.creditsPerMillionInput}</td>
                  <td className="num">{m.creditsPerMillionOutput}</td>
                  <td className="num">{m.creditsPerAudioSecond}</td>
                  <td>
                    <button
                      className="ghost small"
                      onClick={async () => {
                        await client.updateAiModel(m.id, { enabled: !m.enabled })
                        await load()
                      }}
                    >
                      {m.enabled ? t('billing.disable') : t('billing.enable')}
                    </button>{' '}
                    <button
                      className="danger small"
                      onClick={async () => {
                        await client.deleteAiModel(m.id)
                        await load()
                      }}
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

// ══════════ 用量报表 ══════════

function UsageTab({ client }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [rows, setRows] = useState<
    Array<{ modelId: string; purpose: string; calls: number; credits: number }>
  >([])
  const [models, setModels] = useState<AiModelRow[]>([])

  useEffect(() => {
    void Promise.all([client.usageSummary(), client.listAiModels()]).then(([u, m]) => {
      setRows(u.summary)
      setModels(m.models)
    })
  }, [client])

  const nameOf = (id: string): string => {
    const m = models.find((x) => x.id === id)
    return m ? m.label || m.modelName : id
  }

  return (
    <section className="card">
      <h3>{t('billing.usage')}</h3>
      {rows.length === 0 ? (
        <p className="muted small">{t('common.empty')}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('billing.modelName')}</th>
              <th>{t('billing.purposes')}</th>
              <th className="num">{t('billing.calls')}</th>
              <th className="num">{t('billing.credits')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{nameOf(r.modelId)}</td>
                <td>{t(`billing.purpose.${r.purpose}` as 'billing.purpose.asr')}</td>
                <td className="num">{r.calls}</td>
                <td className="num">{r.credits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}


// ══════════ 订单与余额（手动补单 / 调余额） ══════════

function OrdersTab({ client }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [status, setStatus] = useState('pending')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  // 余额调整表单
  const [email, setEmail] = useState('')
  const [amount, setAmount] = useState('')
  const [direction, setDirection] = useState<'add' | 'deduct'>('add')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    try {
      setOrders((await client.listAdminOrders(status || undefined)).orders)
      setErr('')
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }, [client, status])

  useEffect(() => {
    void load()
  }, [load])

  const usd = (c: number): string => `$${(c / 100).toFixed(2)}`

  return (
    <>
      <section className="card">
        <h3>{t('billing.adjust')}</h3>
        <p className="hint">{t('billing.adjustHint')}</p>
        <div className="form-row">
          <label>
            <span>{t('billing.userEmail')}</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
          </label>
          <label>
            <span>{t('billing.adjustDirection')}</span>
            <select value={direction} onChange={(e) => setDirection(e.target.value as 'add')}>
              <option value="add">{t('billing.adjustAdd')}</option>
              <option value="deduct">{t('billing.adjustDeduct')}</option>
            </select>
          </label>
          <label>
            <span>{t('billing.amountUsd')}</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10.00" />
          </label>
          <label>
            <span>{t('billing.note')}</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={busy === 'adjust'}
            onClick={async () => {
              setErr('')
              setMsg('')
              const cents = Math.round(Number(amount) * 100)
              if (!email.trim() || !Number.isFinite(cents) || cents <= 0) {
                return setErr(t('billing.adjustInvalid'))
              }
              setBusy('adjust')
              try {
                const r = await client.adjustBalance({
                  email: email.trim(),
                  deltaCents: direction === 'add' ? cents : -cents,
                  note: note.trim() || undefined
                })
                setMsg(t('billing.adjustDone').replace('{balance}', usd(r.balance.balanceCents)))
                setAmount('')
                setNote('')
              } catch (e) {
                setErr(String((e as Error).message ?? e))
              } finally {
                setBusy('')
              }
            }}
          >
            {t('common.save')}
          </button>
        </div>
        {msg && <p className="ok-hint">{msg}</p>}
      </section>

      <section className="card">
        <div className="toolbar">
          <h3>{t('billing.orders')}</h3>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">{t('billing.statusPending')}</option>
            <option value="paid">{t('billing.statusPaid')}</option>
            <option value="expired">{t('billing.statusExpired')}</option>
            <option value="">{t('billing.statusAll')}</option>
          </select>
        </div>
        {err && <div className="error-banner">{err}</div>}
        <table className="table">
          <thead>
            <tr>
              <th>{t('billing.orderTime')}</th>
              <th>{t('billing.userEmail')}</th>
              <th>{t('billing.orderKind')}</th>
              <th>{t('billing.orderAmount')}</th>
              <th>{t('billing.orderPayable')}</th>
              <th>{t('billing.orderStatus')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td title={o.id}>{new Date(o.createdAt).toLocaleString()}</td>
                <td>{o.email ?? o.userId}</td>
                <td>{o.kind === 'plan' ? t('billing.kindPlan') : t('billing.kindTopup')}</td>
                <td>{usd(o.amountCents)}</td>
                <td>
                  {(o.payableLocal / 100).toFixed(2)} {o.currency}
                </td>
                <td>{o.status}</td>
                <td>
                  {o.status === 'pending' && (
                    <button
                      className="primary"
                      disabled={busy === o.id}
                      onClick={async () => {
                        if (!window.confirm(t('billing.markPaidConfirm'))) return
                        setBusy(o.id)
                        try {
                          await client.markOrderPaid(o.id)
                          setMsg(t('billing.markPaidDone'))
                          await load()
                        } catch (e) {
                          setErr(String((e as Error).message ?? e))
                        } finally {
                          setBusy('')
                        }
                      }}
                    >
                      {t('billing.markPaid')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={7} className="hint">
                  {t('billing.noOrders')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  )
}
