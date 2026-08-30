import { useCallback, useEffect, useMemo, useState } from 'react'
import { errText } from '../errors'
import type { AccountProfile, Campaign, CampaignLink, CampaignStats, FanLibrary } from '@shared/campaign'
import { LIBRARY_CHANNELS } from '@shared/campaign'
import {
  CheckGrid,
  DateField,
  fromLocalInput,
  startOfDay,
  toLocalInput,
  type DatePreset
} from '../components/form-bits'
import { DEFAULT_GREETING, entryLink, isValidCode, type EntryChannel } from '@shared/entry-link'
import { useI18n } from '../i18n'

const api = window.omni

export interface AccountOption {
  key: string
  label: string
  channel: string
  accountId: string
  /** 该账号对外的联系方式（登录后才有；LINE 取不到） */
  selfHandle?: string
  /** 账号自身头像（本地媒体库 ID） */
  avatarMediaId?: string
  /** 工单展示用的账号状态 */
  status?: 'online' | 'offline' | 'error'
}

interface CampaignAccountOption {
  value: string
  label: string
  channel: string
  sub?: string
}

interface Props {
  accounts: AccountOption[]
}

type Tab = 'campaigns' | 'libraries' | 'links'

function platformLabel(channel: string, removedLabel: string): string {
  switch (channel) {
    case 'whatsapp':
      return 'WhatsApp'
    case 'telegram':
      return 'Telegram'
    case 'telegram_bot':
      return 'Telegram Bot'
    case 'line':
      return 'LINE'
    case 'removed':
      return removedLabel
    default:
      return channel
  }
}

/** 工单账号选择：按平台切换，当前平台内搜索并勾选，适合数百账号。 */
function PlatformAccountPicker({
  label,
  hint,
  options,
  selected,
  emptyText,
  onChange
}: {
  label: string
  hint?: string
  options: CampaignAccountOption[]
  selected: string[]
  emptyText?: string
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const channels = useMemo(
    () => Array.from(new Set(options.map((option) => option.channel))),
    [options]
  )
  const [activeChannel, setActiveChannel] = useState(channels[0] ?? '')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!channels.includes(activeChannel)) setActiveChannel(channels[0] ?? '')
  }, [activeChannel, channels])

  const activeOptions = useMemo(
    () => options.filter((option) => option.channel === activeChannel),
    [activeChannel, options]
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return activeOptions
    return activeOptions.filter(
      (option) => option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q)
    )
  }, [activeOptions, query])
  const allShownPicked = filtered.length > 0 && filtered.every((option) => selected.includes(option.value))

  const toggle = (value: string): void =>
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value])

  return (
    <div className="field check-field platform-account-picker">
      <div className="check-head">
        <span>{label}</span>
        <span className="check-count">{selected.length}/{options.length}</span>
        <button
          type="button"
          className="chip"
          disabled={filtered.length === 0}
          onClick={() =>
            onChange(
              allShownPicked
                ? selected.filter((value) => !filtered.some((option) => option.value === value))
                : [...new Set([...selected, ...filtered.map((option) => option.value)])]
            )
          }
        >
          {allShownPicked ? t('form.clearAll') : t('form.selectAll')}
        </button>
      </div>

      {channels.length > 0 && (
        <div className="campaign-platform-tabs" role="tablist" aria-label={label}>
          {channels.map((channel) => {
            const count = options.filter((option) => option.channel === channel).length
            const pickedCount = options.filter(
              (option) => option.channel === channel && selected.includes(option.value)
            ).length
            return (
              <button
                key={channel}
                type="button"
                role="tab"
                aria-selected={activeChannel === channel}
                className={activeChannel === channel ? 'on' : ''}
                onClick={() => {
                  setActiveChannel(channel)
                  setQuery('')
                }}
              >
                <span>{platformLabel(channel, t('campaign.removedAccount'))}</span>
                <span className="campaign-platform-count">
                  {pickedCount > 0 ? `${pickedCount}/` : ''}{count}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {options.length === 0 ? (
        <p className="field-hint">{emptyText ?? t('form.noOptions')}</p>
      ) : (
        <>
          <input
            type="text"
            className="check-search"
            value={query}
            placeholder={t('form.search')}
            onChange={(event) => setQuery(event.target.value)}
          />
          {filtered.length === 0 ? (
            <p className="field-hint">{t('form.noMatch')}</p>
          ) : (
            <div className="check-grid campaign-account-grid">
              {filtered.map((option) => (
                <label key={option.value} className={`check-item ${selected.includes(option.value) ? 'picked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selected.includes(option.value)}
                    onChange={() => toggle(option.value)}
                  />
                  <span className="check-label">{option.label}</span>
                  {option.sub && <span className="check-sub">{option.sub}</span>}
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  )
}

function fmt(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

/**
 * 工单与重粉库 —— 独立整页。
 *
 * 做成整页而不是弹窗：判重规则要同时选账号、选库、选时间，弹窗里挤不下，
 * 而且老板看统计时会在这里停留较久。
 */
export function CampaignPage({ accounts }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('campaigns')
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [libraries, setLibraries] = useState<FanLibrary[]>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Campaign | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const [c, l] = await Promise.all([
        api.campaign<Campaign[]>('listCampaigns'),
        api.campaign<FanLibrary[]>('listLibraries')
      ])
      setCampaigns(c)
      setLibraries(l)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const detail = detailId ? campaigns.find((c) => c.id === detailId) : undefined

  return (
    <div className="page">
      <header className="page-header">
        <h1>{t('campaign.title')}</h1>
        <div className="page-tabs">
          <button
            type="button"
            className={tab === 'campaigns' ? 'on' : ''}
            onClick={() => {
              setTab('campaigns')
              setDetailId(null)
              setCreating(false)
              setEditing(null)
            }}
          >
            {t('campaign.tabCampaigns')}
          </button>
          <button
            type="button"
            className={tab === 'libraries' ? 'on' : ''}
            onClick={() => setTab('libraries')}
          >
            {t('campaign.tabLibraries')}
          </button>
          <button
            type="button"
            className={tab === 'links' ? 'on' : ''}
            onClick={() => setTab('links')}
          >
            {t('campaign.tabLinks')}
          </button>
        </div>
      </header>

      <div className="page-body">
        {err && (
          <div className="campaign-error">
            <p className="auth-err">{err}</p>
            <button type="button" className="ghost-btn" onClick={() => void load()}>
              {t('campaign.retry')}
            </button>
          </div>
        )}
        {loading && <p className="field-hint">{t('campaign.loading')}</p>}

        {!loading && tab === 'campaigns' && (
          <>
            {editing ? (
              <CampaignForm
                accounts={accounts}
                libraries={libraries}
                editing={editing}
                onCancel={() => setEditing(null)}
                onCreated={async () => {
                  setEditing(null)
                  await load()
                }}
              />
            ) : detail ? (
              <CampaignDetail
                campaign={detail}
                onBack={() => setDetailId(null)}
                onChanged={load}
                onEdit={() => setEditing(detail)}
              />
            ) : creating ? (
              <CampaignForm
                accounts={accounts}
                libraries={libraries}
                onCancel={() => setCreating(false)}
                onCreated={async () => {
                  setCreating(false)
                  await load()
                }}
              />
            ) : (
              <>
                <div className="page-toolbar">
                  <button type="button" className="primary-btn" onClick={() => setCreating(true)}>
                    {t('campaign.create')}
                  </button>
                </div>
                {campaigns.length === 0 ? (
                  <p className="empty-hint">{t('campaign.empty')}</p>
                ) : (
                  <div className="campaign-table-wrap">
                    <table className="data-table campaign-table">
                      <thead>
                        <tr>
                          <th>工单编号</th>
                          <th>工单名称</th>
                          <th>平台</th>
                          <th>{t('campaign.startAt')}</th>
                          <th>{t('campaign.endAt')}</th>
                          <th>{t('campaign.resetTime')}</th>
                          <th className="num">账号数量</th>
                          <th className="num">总目标</th>
                          <th className="campaign-operation-head">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {campaigns.map((c) => {
                          const channels = Array.from(
                            new Set(
                                c.accountIds
                                  .map((id) => c.accountProfiles[id]?.channel)
                                .filter((channel): channel is string => Boolean(channel))
                            )
                          )
                          const platform = channels.length
                            ? channels.map((channel) => platformLabel(channel, t('campaign.removedAccount'))).join(' / ')
                            : '—'
                          return (
                            <tr key={c.id}>
                              <td className="campaign-id" title={c.id}>{c.id}</td>
                              <td className="campaign-name-cell">{c.name}</td>
                              <td>{platform}</td>
                              <td>{fmt(c.startAt)}</td>
                              <td>{c.endAt ? fmt(c.endAt) : t('campaign.ongoing')}</td>
                              <td>{c.resetTime || '00:00'}</td>
                              <td className="num">{c.accountIds.length}</td>
                              <td className="num">{c.totalTarget || 0}</td>
                              <td className="campaign-operation-cell">
                                <div className="campaign-actions">
                                  <button type="button" className="table-action" onClick={() => setDetailId(c.id)}>
                                    查看
                                  </button>
                                  <button type="button" className="table-action" onClick={() => setEditing(c)}>
                                    {t('campaign.edit')}
                                  </button>
                                  <button
                                    type="button"
                                    className="table-action danger"
                                    onClick={async () => {
                                      if (!window.confirm(t('campaign.deleteConfirm'))) return
                                      await api.campaign('deleteCampaign', c.id)
                                      await load()
                                    }}
                                  >
                                    {t('campaign.delete')}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {!loading && tab === 'libraries' && (
          <LibraryPanel libraries={libraries} accounts={accounts} onChanged={load} />
        )}

        {tab === 'links' && <EntryLinkPanel accounts={accounts} />}
      </div>
    </div>
  )
}

/** 新建 / 编辑工单（传 editing 即编辑模式，字段预填） */
function CampaignForm({
  accounts,
  libraries,
  editing,
  onCancel,
  onCreated
}: {
  accounts: AccountOption[]
  libraries: FanLibrary[]
  editing?: Campaign
  onCancel: () => void
  onCreated: () => Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()
  // 编辑时按 accountId 反查本机账号 key；已不在本机的账号用 gone: 前缀保留可选
  const keyOf = (accountId: string): string =>
    accounts.find((a) => a.accountId === accountId)?.key ?? `gone:${accountId}`
  const [name, setName] = useState(editing?.name ?? '')
  const [picked, setPicked] = useState<string[]>(editing ? editing.accountIds.map(keyOf) : [])
  const [startAt, setStartAt] = useState(toLocalInput(editing?.startAt ?? startOfDay()))
  const [endAt, setEndAt] = useState(editing?.endAt ? toLocalInput(editing.endAt) : '')
  const [resetTime, setResetTime] = useState(editing?.resetTime ?? '00:00')
  const [totalTarget, setTotalTarget] = useState(String(editing?.totalTarget ?? 0))
  const [accountTargets, setAccountTargets] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(editing?.accountTargets ?? {}).map(([id, value]) => [id, String(value)]))
  )
  const [libIds, setLibIds] = useState<string[]>(editing?.dedupLibraryIds ?? [])
  /** 投放来源码，空格/逗号分隔；空 = 全部来源 */
  const [sources, setSources] = useState((editing?.sourceCodes ?? []).join(' '))
  /** 公开看板地区限制：默认拒绝大陆与香港 */
  const [allowCn, setAllowCn] = useState(editing?.allowCnIp ?? false)
  const [allowHk, setAllowHk] = useState(editing?.allowHkIp ?? false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const accountOptions: CampaignAccountOption[] = [
    ...accounts.map((a) => ({ value: a.key, label: a.label, channel: a.channel, sub: a.channel })),
    // 工单里存过、但本机已删掉的账号：仍然展示，让老板能保留或移除
    ...(editing?.accountIds ?? [])
      .filter((id) => !accounts.some((a) => a.accountId === id))
      .map((id) => ({
        value: `gone:${id}`,
        label: editing?.accountLabels[id] ?? id,
        channel: 'removed',
        sub: t('campaign.removedAccount')
      }))
  ]

  // 判重库按平台隔离：标识体系不同，跨平台选了也永远不会命中
  const pickedChannels = new Set(
    picked.map((k) => accounts.find((a) => a.key === k)?.channel).filter(Boolean) as string[]
  )
  const usableLibs = libraries.filter(
    (l) => pickedChannels.size === 0 || pickedChannels.has(l.channel)
  )

  useEffect(() => {
    setAccountTargets((current) => {
      const next: Record<string, string> = {}
      for (const key of picked) {
        const id = key.startsWith('gone:') ? key.slice(5) : (accounts.find((a) => a.key === key)?.accountId ?? key)
        next[id] = current[id] ?? String(editing?.accountTargets?.[id] ?? '')
      }
      return next
    })
  }, [accounts, editing?.accountTargets, picked])

  const startPresets: DatePreset[] = [
    { label: t('form.now'), value: () => Date.now() },
    { label: t('form.today'), value: () => startOfDay() },
    { label: t('form.yesterday'), value: () => startOfDay(-1) },
    { label: t('form.days7ago'), value: () => startOfDay(-7) }
  ]
  const endPresets: DatePreset[] = [
    { label: t('form.clear'), value: () => undefined },
    { label: t('form.tomorrow'), value: () => startOfDay(2) },
    { label: t('form.days3'), value: () => startOfDay(4) },
    { label: t('form.days7'), value: () => startOfDay(8) },
    { label: t('form.days30'), value: () => startOfDay(31) }
  ]
  const submit = async (): Promise<void> => {
    setErr('')
    // gone: 前缀 = 本机已删的账号，accountId 与备注名从工单原数据取
    const toAccountId = (key: string): string =>
      key.startsWith('gone:') ? key.slice(5) : (accounts.find((a) => a.key === key)?.accountId ?? key)
    const start = fromLocalInput(startAt)
    if (!name.trim()) return setErr(t('campaign.errName'))
    if (picked.length === 0) return setErr(t('campaign.errAccounts'))
    if (start === undefined) return setErr(t('campaign.errStart'))
    const end = fromLocalInput(endAt)
    if (end !== undefined && end <= start) return setErr(t('campaign.errEnd'))
    const parsedTotalTarget = Number(totalTarget || 0)
    if (!Number.isInteger(parsedTotalTarget) || parsedTotalTarget < 0) return setErr(t('campaign.errTarget'))
    const parsedAccountTargets: Record<string, number> = {}
    for (const key of picked) {
      const accountId = toAccountId(key)
      const value = Number(accountTargets[accountId] || 0)
      if (!Number.isInteger(value) || value < 0) return setErr(t('campaign.errTarget'))
      if (value > 0) parsedAccountTargets[accountId] = value
    }
    setBusy(true)
    try {
      const labelOf = (key: string): string =>
        key.startsWith('gone:')
          ? (editing?.accountLabels[key.slice(5)] ?? key.slice(5))
          : (accounts.find((a) => a.key === key)?.label ?? key)
      const accountProfiles: Record<string, AccountProfile> = {}
      for (const key of picked) {
        const accountId = toAccountId(key)
        const account = accounts.find((a) => a.accountId === accountId)
        const previous = editing?.accountProfiles?.[accountId]
        // 账号头像可能在连接后才异步拉取，提交时强制刷新一次。
        const refreshed = key.startsWith('gone:')
          ? undefined
          : await api.refreshChannelProfile(key).catch(() => undefined)
        const profile: AccountProfile = {
          channel: account?.channel ?? previous?.channel ?? 'removed',
          handle: refreshed?.selfHandle ?? account?.selfHandle ?? previous?.handle,
          status:
            refreshed?.status === 'connected'
              ? 'online'
              : account?.status ?? previous?.status ?? 'offline'
        }
        // 账号头像在本机媒体库中，先上传到后台，分享页才能在客户端关闭后继续显示。
        // 刷新接口可能因平台暂时不可用返回空，不能因此覆盖客户端已有头像。
        // 刷新资料可能因平台限流暂时返回空；优先用刷新结果，否则保留客户端已有或工单旧头像。
        const avatarMediaId = refreshed?.avatarMediaId ?? account?.avatarMediaId ?? previous?.avatarMediaId
        if (avatarMediaId) {
          try {
            const local = await fetch(`omni-media://local/${encodeURIComponent(avatarMediaId)}`)
            if (local.ok) {
              const mimeType = local.headers.get('content-type') || 'image/png'
              const bytes = new Uint8Array(await local.arrayBuffer())
              const uploaded = await api.campaign<string>('uploadAvatar', bytes, mimeType)
              if (uploaded) profile.avatarMediaId = uploaded
            }
          } catch {
            // 头像读取/上传失败不应阻断工单创建；分享页会明确显示“无”。
          }
        } else {
          // 没有真实头像时明确保存为空，分享页显示“无”。
          profile.avatarMediaId = undefined
        }
        accountProfiles[accountId] = profile
      }
      const payload = {
        name: name.trim(),
        accountIds: picked.map(toAccountId),
        accountLabels: Object.fromEntries(picked.map((k) => [toAccountId(k), labelOf(k)])),
        accountProfiles,
        startAt: start,
        endAt: end,
        resetTime,
        totalTarget: parsedTotalTarget,
        accountTargets: parsedAccountTargets,
        // 只提交与所选账号同平台的库，避免改过账号后留下永不命中的脏规则
        dedupLibraryIds: libIds.filter((id) => usableLibs.some((l) => l.id === id)),
        sourceCodes: sources.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean),
        allowCnIp: allowCn,
        allowHkIp: allowHk,
        tzOffsetMinutes: -new Date().getTimezoneOffset()
      }
      if (editing) {
        // 编辑时结束时间清空要显式传 null，不能靠 undefined（会被当成"不改"）
        // 同时清空旧版本保存的时间判重字段，统一改为只按重粉库命中判重。
        await api.campaign('updateCampaign', editing.id, {
          ...payload,
          endAt: end ?? null,
          dedupBeforeAt: null,
          dedupAccountIds: []
        })
      } else {
        await api.campaign('createCampaign', payload)
      }
      await onCreated()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form-page">
      <div className="page-toolbar">
        <button type="button" className="ghost-btn" onClick={onCancel}>
          ← {t('campaign.back')}
        </button>
        <strong>{editing ? t('campaign.edit') : t('campaign.create')}</strong>
      </div>

      <section className="form-card">
        <h3>{t('campaign.basic')}</h3>
        <label className="field">
          <span>{t('campaign.name')}</span>
          <input
            type="text"
            value={name}
            placeholder={t('campaign.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <PlatformAccountPicker
          label={t('campaign.accounts')}
          hint={t('campaign.accountsHint')}
          options={accountOptions}
          selected={picked}
          onChange={setPicked}
        />

        <div className="field-row">
          <DateField
            label={t('campaign.startAt')}
            value={startAt}
            presets={startPresets}
            onChange={setStartAt}
          />
          <DateField
            label={t('campaign.endAt')}
            hint={t('campaign.endHint')}
            value={endAt}
            presets={endPresets}
            onChange={setEndAt}
          />
          <label className="field time-field">
            <span>{t('campaign.resetTime')}</span>
            <input type="time" value={resetTime} onChange={(e) => setResetTime(e.target.value)} />
            <span className="field-hint">{t('campaign.resetTimeHint')}</span>
          </label>
        </div>

        <div className="target-settings">
          <label className="field target-total-field">
            <span>{t('campaign.totalTarget')}</span>
            <input type="number" min="0" step="1" value={totalTarget} onChange={(e) => setTotalTarget(e.target.value)} />
            <span className="field-hint">{t('campaign.totalTargetHint')}</span>
          </label>
          <div className="field account-target-field">
            <span>{t('campaign.accountTargets')}</span>
            <div className="account-target-list">
              {picked.map((key) => {
                const accountId = key.startsWith('gone:') ? key.slice(5) : (accounts.find((a) => a.key === key)?.accountId ?? key)
                const account = accounts.find((a) => a.accountId === accountId)
                return (
                  <label className="account-target-row" key={accountId}>
                    <span>{account?.label ?? editing?.accountLabels[accountId] ?? accountId}</span>
                    <input type="number" min="0" step="1" value={accountTargets[accountId] ?? ''} placeholder="0" onChange={(e) => setAccountTargets((current) => ({ ...current, [accountId]: e.target.value }))} />
                  </label>
                )
              })}
            </div>
            <span className="field-hint">{t('campaign.accountTargetsHint')}</span>
          </div>
        </div>

        <label className="field">
          <span>{t('campaign.sources')}</span>
          <input
            type="text"
            value={sources}
            placeholder="ad-001 promo2026"
            onChange={(e) => setSources(e.target.value)}
          />
          <span className="field-hint">{t('campaign.sourcesHint')}</span>
        </label>

        <div className="field">
          <span>{t('campaign.regionLimit')}</span>
          <label className="check-row">
            <input
              type="checkbox"
              checked={allowCn}
              onChange={(e) => setAllowCn(e.target.checked)}
            />
            <span>{t('campaign.allowCn')}</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={allowHk}
              onChange={(e) => setAllowHk(e.target.checked)}
            />
            <span>{t('campaign.allowHk')}</span>
          </label>
          <span className="field-hint">{t('campaign.regionHint')}</span>
        </div>
      </section>

      <section className="form-card">
        <h3>{t('campaign.dedup')}</h3>
        <p className="field-hint">{t('campaign.dedupHint')}</p>

        <div className="rule-block">
          <h4>{t('campaign.rule1')}</h4>
          <CheckGrid
            label={t('campaign.dedupLibs')}
            options={usableLibs.map((l) => ({
              value: l.id,
              label: l.name,
              sub: `${l.channel} · ${l.entryCount}`
            }))}
            selected={libIds}
            emptyText={t('campaign.noLibs')}
            onChange={setLibIds}
          />
        </div>

      </section>

      {err && <p className="auth-err">{err}</p>}

      <div className="page-toolbar end">
        <button type="button" className="ghost-btn" onClick={onCancel}>
          {t('settings.cancel')}
        </button>
        <button type="button" className="primary-btn" disabled={busy} onClick={() => void submit()}>
          {editing ? t('campaign.save') : t('campaign.create')}
        </button>
      </div>
    </div>
  )
}

/** 工单详情：统计概览 + 分享链接 */
function CampaignDetail({
  campaign,
  onBack,
  onChanged,
  onEdit
}: {
  campaign: Campaign
  onBack: () => void
  onChanged: () => Promise<void>
  onEdit: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [stats, setStats] = useState<CampaignStats | null>(null)
  const [links, setLinks] = useState<CampaignLink[]>([])
  const [publicBase, setPublicBase] = useState('')
  const [err, setErr] = useState('')
  const [label, setLabel] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')

  const refresh = useCallback(async () => {
    setErr('')
    try {
      const [s, l] = await Promise.all([
        api.campaign<{ stats: CampaignStats }>('campaignStats', campaign.id),
        api.campaign<{ links: CampaignLink[]; publicBase: string }>('listLinks', campaign.id)
      ])
      setStats(s.stats)
      setLinks(l.links)
      setPublicBase(l.publicBase)
    } catch (e) {
      setErr(errText(e))
    }
  }, [campaign.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const linkPresets: DatePreset[] = [
    { label: t('campaign.never'), value: () => undefined },
    { label: t('form.days7'), value: () => startOfDay(8) },
    { label: t('form.days30'), value: () => startOfDay(31) }
  ]

  return (
    <div className="form-page">
      <div className="page-toolbar">
        <button type="button" className="ghost-btn" onClick={onBack}>
          ← {t('campaign.back')}
        </button>
        <strong>{campaign.name}</strong>
        <button type="button" className="ghost-btn" onClick={onEdit}>
          {t('campaign.edit')}
        </button>
        <button
          type="button"
          className="danger-btn"
          onClick={async () => {
            if (!window.confirm(t('campaign.deleteConfirm'))) return
            await api.campaign('deleteCampaign', campaign.id)
            await onChanged()
            onBack()
          }}
        >
          {t('campaign.delete')}
        </button>
      </div>

      {err && <p className="auth-err">{err}</p>}

      {stats && (
        <>
          <div className="stat-cards">
            <div className="stat-card">
              <span className="k">{t('campaign.total')}</span>
              <span className="v">{stats.total}</span>
            </div>
            <div className="stat-card">
              <span className="k">{t('campaign.fresh')}</span>
              <span className="v fresh">{stats.fresh}</span>
            </div>
            <div className="stat-card">
              <span className="k">{t('campaign.duplicate')}</span>
              <span className="v dup">{stats.duplicate}</span>
            </div>
            <div className="stat-card">
              <span className="k">{t('campaign.replyRate')}</span>
              <span className="v">{Math.round(stats.response.replyRate * 100)}%</span>
            </div>
            <div className="stat-card">
              <span className="k">{t('campaign.totalTarget')}</span>
              <span className="v">{campaign.totalTarget || 0}</span>
            </div>
          </div>

          {stats.bySource.length > 0 && (
            <section className="form-card">
              <h3>{t('campaign.bySource')}</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('campaign.source')}</th>
                    <th>{t('campaign.sourceVia')}</th>
                    <th className="num">{t('campaign.total')}</th>
                    <th className="num">{t('campaign.fresh')}</th>
                    <th className="num">{t('campaign.duplicate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.bySource.map((r) => (
                    <tr key={r.code || '__none__'}>
                      <td>{r.code || t('campaign.noSource')}</td>
                      <td>
                        {r.via === 'ad'
                          ? t('campaign.viaAd')
                          : r.via === 'code'
                            ? t('campaign.viaCode')
                            : '—'}
                      </td>
                      <td className="num">{r.total}</td>
                      <td className="num">{r.fresh}</td>
                      <td className="num">{r.duplicate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {stats.byAccount.length > 0 && (
            <section className="form-card">
              <h3>{t('campaign.byAccount')}</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('campaign.account')}</th>
                    <th>{t('campaign.platform')}</th>
                    <th className="num">{t('campaign.target')}</th>
                    <th className="num">{t('campaign.total')}</th>
                    <th className="num">{t('campaign.fresh')}</th>
                    <th className="num">{t('campaign.duplicate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byAccount.map((a) => (
                    <tr key={a.accountId}>
                      <td>{a.label || a.accountId}</td>
                      <td>{a.channel}</td>
                      <td className="num">{campaign.accountTargets?.[a.accountId] || 0}</td>
                      <td className="num">{a.total}</td>
                      <td className="num">{a.fresh}</td>
                      <td className="num">{a.duplicate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      <section className="form-card">
        <h3>{t('campaign.links')}</h3>
        <p className="field-hint">{t('campaign.linksHint')}</p>

        <div className="field-row">
          <label className="field">
            <span>{t('campaign.linkLabel')}</span>
            <input
              type="text"
              value={label}
              placeholder={t('campaign.linkLabelPlaceholder')}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <DateField
            label={t('campaign.linkExpires')}
            hint={t('campaign.expiresHint')}
            value={expiresAt}
            presets={linkPresets}
            onChange={setExpiresAt}
          />
        </div>
        <button
          type="button"
          className="primary-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await api.campaign('createLink', campaign.id, {
                label: label.trim() || undefined,
                expiresAt: fromLocalInput(expiresAt)
              })
              setLabel('')
              setExpiresAt('')
              await refresh()
            } catch (e) {
              setErr(errText(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          {t('campaign.addLink')}
        </button>

        {links.length === 0 ? (
          <p className="empty-hint">{t('campaign.noLinks')}</p>
        ) : (
          <ul className="link-list">
            {links.map((l) => {
              const url = `${publicBase}/c/${l.token}`
              const expired = l.expiresAt !== undefined && l.expiresAt <= Date.now()
              return (
                <li key={l.token} className={l.active ? '' : 'off'}>
                  <div className="link-main">
                    <span className="link-label">{l.label || t('campaign.unnamed')}</span>
                    <code className="link-url">{url}</code>
                  </div>
                  <span className="link-state">
                    {l.revoked
                      ? t('campaign.revoked')
                      : l.expiresAt !== undefined
                        ? l.active
                          ? `${fmt(l.expiresAt)} ${t('campaign.expiresAt')}`
                          : t('campaign.expired')
                        : t('campaign.never')}
                  </span>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => {
                      void navigator.clipboard.writeText(url)
                      setCopied(l.token)
                      setTimeout(() => setCopied(''), 1500)
                    }}
                  >
                    {copied === l.token ? t('campaign.copied') : t('campaign.copy')}
                  </button>
                  {l.revoked && !expired ? (
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={async () => {
                        await api.campaign('restoreLink', l.token)
                        await refresh()
                      }}
                    >
                      {t('campaign.restore')}
                    </button>
                  ) : l.active ? (
                    <button
                      type="button"
                      className="danger-btn"
                      onClick={async () => {
                        await api.campaign('revokeLink', l.token)
                        await refresh()
                      }}
                    >
                      {t('campaign.revoke')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="danger-btn"
                    title={t('campaign.deleteLinkHint')}
                    onClick={async () => {
                      if (!window.confirm(t('campaign.deleteLinkConfirm'))) return
                      await api.campaign('deleteLink', l.token)
                      await refresh()
                    }}
                  >
                    {t('campaign.deleteLink')}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

/** 重粉库：从历史导出，或导入外部名单 */
function LibraryPanel({
  libraries,
  accounts,
  onChanged
}: {
  libraries: FanLibrary[]
  accounts: AccountOption[]
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()
  const [mode, setMode] = useState<'export' | 'import'>('export')
  const [name, setName] = useState('')
  const [channel, setChannel] = useState<string>('whatsapp')
  const [contacts, setContacts] = useState('')
  const [lineProvider, setLineProvider] = useState('')
  const [pickedAccounts, setPickedAccounts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState('')

  const sameChannel = accounts.filter((a) => a.channel === channel)

  const submit = async (): Promise<void> => {
    setErr('')
    setResult('')
    if (!name.trim()) return setErr(t('campaign.errLibName'))
    setBusy(true)
    try {
      if (mode === 'export') {
        // 不选账号 = 该平台全部账号
        const ids = pickedAccounts.length
          ? accounts.filter((a) => pickedAccounts.includes(a.key)).map((a) => a.accountId)
          : sameChannel.map((a) => a.accountId)
        const r = await api.campaign<{ added: number }>('exportLibrary', {
          name: name.trim(),
          channel,
          accountIds: ids
        })
        setResult(t('campaign.exported').replace('{n}', String(r.added)))
      } else {
        const r = await api.campaign<{
          added: number
          parsed: { errors: string[]; duplicates: number }
        }>('importLibrary', {
          name: name.trim(),
          channel,
          contacts,
          lineProvider: lineProvider.trim() || undefined
        })
        // 问题行必须让用户看见，否则名单少了一半也不知道
        const parts = [t('campaign.imported').replace('{n}', String(r.added))]
        if (r.parsed.duplicates) {
          parts.push(t('campaign.importDup').replace('{n}', String(r.parsed.duplicates)))
        }
        if (r.parsed.errors.length) {
          parts.push(
            `${t('campaign.importErr').replace('{n}', String(r.parsed.errors.length))}：${r.parsed.errors
              .slice(0, 3)
              .join('；')}`
          )
        }
        setResult(parts.join(' · '))
      }
      setName('')
      setContacts('')
      await onChanged()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form-page">
      <section className="form-card">
        <h3>{t('campaign.newLib')}</h3>
        <div className="page-tabs inline">
          <button
            type="button"
            className={mode === 'export' ? 'on' : ''}
            onClick={() => setMode('export')}
          >
            {t('campaign.fromHistory')}
          </button>
          <button
            type="button"
            className={mode === 'import' ? 'on' : ''}
            onClick={() => setMode('import')}
          >
            {t('campaign.fromList')}
          </button>
        </div>

        <div className="field-row">
          <label className="field">
            <span>{t('campaign.libName')}</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>{t('campaign.platform')}</span>
            <select
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value)
                setPickedAccounts([])
              }}
            >
              {LIBRARY_CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {mode === 'export' ? (
          <>
            <CheckGrid
              label={t('campaign.exportAccounts')}
              hint={t('campaign.exportHint')}
              options={sameChannel.map((a) => ({ value: a.key, label: a.label, sub: a.channel }))}
              selected={pickedAccounts}
              emptyText={t('campaign.noAccountsForChannel')}
              onChange={setPickedAccounts}
            />
          </>
        ) : (
          <>
            <label className="field">
              <span>{t('campaign.contacts')}</span>
              <textarea
                rows={8}
                value={contacts}
                placeholder={t('campaign.contactsPlaceholder')}
                onChange={(e) => setContacts(e.target.value)}
              />
            </label>
            <p className="field-hint">{t('campaign.contactsHint')}</p>
            {channel === 'line' && (
              <label className="field">
                <span>{t('campaign.lineProvider')}</span>
                <input
                  type="text"
                  value={lineProvider}
                  onChange={(e) => setLineProvider(e.target.value)}
                />
                <p className="field-hint">{t('campaign.lineProviderHint')}</p>
              </label>
            )}
          </>
        )}

        {err && <p className="auth-err">{err}</p>}
        {result && <p className="field-hint ok">{result}</p>}

        <button type="button" className="primary-btn" disabled={busy} onClick={() => void submit()}>
          {mode === 'export' ? t('campaign.doExport') : t('campaign.doImport')}
        </button>
      </section>

      <section className="form-card">
        <h3>{t('campaign.existingLibs')}</h3>
        {libraries.length === 0 ? (
          <p className="empty-hint">{t('campaign.noLibs')}</p>
        ) : (
          <ul className="link-list">
            {libraries.map((l) => (
              <li key={l.id}>
                <div className="link-main">
                  <span className="link-label">{l.name}</span>
                  <span className="check-sub">
                    {l.channel} · {l.entryCount} {t('campaign.entriesUnit')} ·{' '}
                    {l.source === 'export' ? t('campaign.fromHistory') : t('campaign.fromList')}
                  </span>
                </div>
                <button
                  type="button"
                  className="danger-btn"
                  onClick={async () => {
                    if (!window.confirm(t('campaign.deleteLibConfirm'))) return
                    await api.campaign('deleteLibrary', l.id)
                    await onChanged()
                  }}
                >
                  {t('campaign.delete')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/**
 * 推广入口链接生成。
 *
 * 三个平台都只有「预填文案」这一个可用参数位，所以追踪码写进客户要发的第一句话。
 * 客户发出后，系统解析出 [ref:xxx] 并固定为该客户的来源，工单统计里按来源拆分。
 */
interface SavedEntryLink {
  id: string
  name: string
  channel: string
  accountId: string
  handle: string
  code: string
  greeting: string
  createdAt: number
}

function EntryLinkPanel({ accounts }: { accounts: AccountOption[] }): React.JSX.Element {
  const { t } = useI18n()
  const [accountKey, setAccountKey] = useState(accounts[0]?.key ?? '')
  const [handle, setHandle] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [greeting, setGreeting] = useState(DEFAULT_GREETING)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState<SavedEntryLink[]>([])
  const [copiedId, setCopiedId] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      const r = await api.campaign<{ links: SavedEntryLink[] }>('listEntryLinks')
      setSaved(r.links)
    } catch (e) {
      setErr(errText(e))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const account = accounts.find((a) => a.key === accountKey)
  const channel = (account?.channel ?? 'whatsapp') as EntryChannel
  const supported = channel === 'whatsapp' || channel === 'telegram' || channel === 'line'

  // 账号登录后能拿到自己的手机号/用户名，优先用它；LINE 拿不到需手填
  const effectiveHandle = handle.trim() || account?.selfHandle || ''
  const codeOk = isValidCode(code)
  const url =
    supported && effectiveHandle && codeOk
      ? entryLink(channel, effectiveHandle, code.trim(), greeting.trim() || DEFAULT_GREETING)
      : ''

  return (
    <div className="form-page">
      <section className="form-card">
        <h3>{t('campaign.linkGen')}</h3>
        <p className="field-hint">{t('campaign.linkGenHint')}</p>

        <div className="field-row">
          <label className="field">
            <span>{t('campaign.account')}</span>
            <select value={accountKey} onChange={(e) => setAccountKey(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}（{a.channel}）
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('campaign.handle')}</span>
            <input
              type="text"
              value={handle}
              placeholder={account?.selfHandle || t('campaign.handlePlaceholder')}
              onChange={(e) => setHandle(e.target.value)}
            />
          </label>
        </div>
        <p className="field-hint">
          {channel === 'line' ? t('campaign.handleLine') : t('campaign.handleAuto')}
        </p>

        <div className="field-row">
          <label className="field">
            <span>{t('campaign.trackCode')}</span>
            <input
              type="text"
              value={code}
              placeholder="fb01 / tiktok_a"
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t('campaign.greeting')}</span>
            <input
              type="text"
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
            />
          </label>
        </div>
        {code && !codeOk && <p className="auth-err">{t('campaign.codeInvalid')}</p>}
        {!supported && <p className="auth-err">{t('campaign.channelUnsupported')}</p>}

        {url && (
          <div className="link-preview">
            <code>{url}</code>
            <button
              type="button"
              className="primary-btn"
              onClick={() => {
                void navigator.clipboard.writeText(url)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? t('campaign.copied') : t('campaign.copy')}
            </button>
          </div>
        )}

        <div className="field-row entry-save-row">
            <label className="field">
              <span>{t('campaign.linkName')}</span>
              <input
                type="text"
                value={name}
                placeholder={t('campaign.linkNamePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="primary-btn"
              disabled={busy || !name.trim() || !url}
              onClick={async () => {
                setErr('')
                setBusy(true)
                try {
                  await api.campaign('createEntryLink', {
                    name: name.trim(),
                    channel,
                    accountId: account?.accountId ?? '',
                    handle: effectiveHandle,
                    code: code.trim(),
                    greeting: greeting.trim() || DEFAULT_GREETING
                  })
                  setName('')
                  setCode('')
                  await reload()
                } catch (e) {
                  setErr(errText(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t('campaign.saveLink')}
            </button>
          </div>
        {!url && <p className="field-hint">{t('campaign.saveNeedsLink')}</p>}
        {err && <p className="auth-err">{err}</p>}
      </section>

      <section className="form-card">
        <h3>{t('campaign.savedLinks')}</h3>
        <p className="field-hint">{t('campaign.savedLinksHint')}</p>
        {saved.length === 0 ? (
          <p className="empty-hint">{t('form.noOptions')}</p>
        ) : (
          <ul className="link-list">
            {saved.map((l) => {
              const u = entryLink(
                l.channel as EntryChannel,
                l.handle,
                l.code,
                l.greeting || DEFAULT_GREETING
              )
              const acc = accounts.find((a) => a.accountId === l.accountId)
              return (
                <li key={l.id}>
                  <div className="link-main">
                    <span className="link-label">
                      {l.name}
                      <span className="link-sub">
                        {' '}
                        · {acc?.label ?? l.accountId} · {t('campaign.trackCode')} {l.code}
                      </span>
                    </span>
                    <code className="link-url">{u}</code>
                  </div>
                  <button
                    type="button"
                    className={`ghost-btn ${copiedId === l.id ? 'copied-ok' : ''}`}
                    onClick={() => {
                      void navigator.clipboard.writeText(u)
                      setCopiedId(l.id)
                      setTimeout(() => setCopiedId(''), 1500)
                    }}
                  >
                    {copiedId === l.id ? t('campaign.copied') : t('campaign.copy')}
                  </button>
                  <button
                    type="button"
                    className="danger-btn"
                    onClick={async () => {
                      if (!window.confirm(t('campaign.deleteLinkConfirm'))) return
                      await api.campaign('deleteEntryLink', l.id)
                      await reload()
                    }}
                  >
                    {t('campaign.deleteLink')}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="form-card">
        <h3>{t('campaign.linkGenTips')}</h3>
        <p className="field-hint">{t('campaign.tipAd')}</p>
        <p className="field-hint">{t('campaign.tipEdit')}</p>
        <p className="field-hint">{t('campaign.tipOnce')}</p>
      </section>
    </div>
  )
}
