import { useCallback, useEffect, useState } from 'react'
import { errText } from '../errors'
import type { Campaign, CampaignLink, CampaignStats, FanLibrary } from '@shared/campaign'
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
}

interface Props {
  accounts: AccountOption[]
}

type Tab = 'campaigns' | 'libraries' | 'links'

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
        {err && <p className="auth-err">{err}</p>}
        {loading && <p className="field-hint">{t('campaign.loading')}</p>}

        {!loading && tab === 'campaigns' && (
          <>
            {detail ? (
              <CampaignDetail
                campaign={detail}
                onBack={() => setDetailId(null)}
                onChanged={load}
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
                  <ul className="campaign-list">
                    {campaigns.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          className="campaign-row"
                          onClick={() => setDetailId(c.id)}
                        >
                          <span className="campaign-name">{c.name}</span>
                          <span className="campaign-meta">
                            {c.accountIds.length} {t('campaign.accountsUnit')} · {fmt(c.startAt)}{' '}
                            {t('campaign.start')}
                            {c.endAt
                              ? ` · ${fmt(c.endAt)} ${t('campaign.end')}`
                              : ` · ${t('campaign.ongoing')}`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
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

/** 新建工单 */
function CampaignForm({
  accounts,
  libraries,
  onCancel,
  onCreated
}: {
  accounts: AccountOption[]
  libraries: FanLibrary[]
  onCancel: () => void
  onCreated: () => Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [startAt, setStartAt] = useState(toLocalInput(startOfDay()))
  const [endAt, setEndAt] = useState('')
  const [libIds, setLibIds] = useState<string[]>([])
  const [beforeAt, setBeforeAt] = useState('')
  /** 时间规则的统计账号；空 = 全部账号 */
  const [dedupAccounts, setDedupAccounts] = useState<string[]>([])
  const [dedupScope, setDedupScope] = useState<'all' | 'pick'>('all')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const accountOptions = accounts.map((a) => ({
    value: a.key,
    label: a.label,
    sub: a.channel
  }))

  // 判重库按平台隔离：标识体系不同，跨平台选了也永远不会命中
  const pickedChannels = new Set(
    picked.map((k) => accounts.find((a) => a.key === k)?.channel).filter(Boolean) as string[]
  )
  const usableLibs = libraries.filter(
    (l) => pickedChannels.size === 0 || pickedChannels.has(l.channel)
  )

  const startPresets: DatePreset[] = [
    { label: t('form.now'), value: () => Date.now() },
    { label: t('form.today'), value: () => startOfDay() },
    { label: t('form.yesterday'), value: () => startOfDay(-1) },
    { label: t('form.days7ago'), value: () => startOfDay(-7) }
  ]
  const endPresets: DatePreset[] = [
    { label: t('form.clear'), value: () => undefined },
    { label: t('form.days7'), value: () => startOfDay(8) },
    { label: t('form.days30'), value: () => startOfDay(31) }
  ]
  const beforePresets: DatePreset[] = [
    { label: t('form.clear'), value: () => undefined },
    { label: t('form.today'), value: () => startOfDay() },
    { label: t('form.days7ago'), value: () => startOfDay(-7) },
    { label: t('form.days30ago'), value: () => startOfDay(-30) },
    { label: t('form.days90ago'), value: () => startOfDay(-90) }
  ]

  const submit = async (): Promise<void> => {
    setErr('')
    const start = fromLocalInput(startAt)
    if (!name.trim()) return setErr(t('campaign.errName'))
    if (picked.length === 0) return setErr(t('campaign.errAccounts'))
    if (start === undefined) return setErr(t('campaign.errStart'))
    const end = fromLocalInput(endAt)
    if (end !== undefined && end <= start) return setErr(t('campaign.errEnd'))
    setBusy(true)
    try {
      const chosen = accounts.filter((a) => picked.includes(a.key))
      await api.campaign('createCampaign', {
        name: name.trim(),
        accountIds: chosen.map((a) => a.accountId),
        accountLabels: Object.fromEntries(chosen.map((a) => [a.accountId, a.label])),
        startAt: start,
        endAt: end,
        // 只提交与所选账号同平台的库，避免改过账号后留下永不命中的脏规则
        dedupLibraryIds: libIds.filter((id) => usableLibs.some((l) => l.id === id)),
        dedupBeforeAt: fromLocalInput(beforeAt),
        dedupAccountIds:
          dedupScope === 'all'
            ? []
            : accounts.filter((a) => dedupAccounts.includes(a.key)).map((a) => a.accountId),
        tzOffsetMinutes: -new Date().getTimezoneOffset()
      })
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
        <strong>{t('campaign.create')}</strong>
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

        <CheckGrid
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

        <div className="rule-block">
          <h4>{t('campaign.rule2')}</h4>
          <DateField
            label={t('campaign.dedupBefore')}
            value={beforeAt}
            presets={beforePresets}
            onChange={setBeforeAt}
          />

          {beforeAt && (
            <>
              <div className="field">
                <span>{t('campaign.dedupScope')}</span>
                <div className="radio-row">
                  <label className="radio-item">
                    <input
                      type="radio"
                      checked={dedupScope === 'all'}
                      onChange={() => setDedupScope('all')}
                    />
                    <span>{t('campaign.scopeAll')}</span>
                  </label>
                  <label className="radio-item">
                    <input
                      type="radio"
                      checked={dedupScope === 'pick'}
                      onChange={() => setDedupScope('pick')}
                    />
                    <span>{t('campaign.scopePick')}</span>
                  </label>
                </div>
              </div>
              {dedupScope === 'pick' && (
                <CheckGrid
                  label={t('campaign.dedupAccounts')}
                  hint={t('campaign.dedupAccountsHint')}
                  options={accountOptions}
                  selected={dedupAccounts}
                  onChange={setDedupAccounts}
                />
              )}
            </>
          )}
        </div>
      </section>

      {err && <p className="auth-err">{err}</p>}

      <div className="page-toolbar end">
        <button type="button" className="ghost-btn" onClick={onCancel}>
          {t('settings.cancel')}
        </button>
        <button type="button" className="primary-btn" disabled={busy} onClick={() => void submit()}>
          {t('campaign.create')}
        </button>
      </div>
    </div>
  )
}

/** 工单详情：统计概览 + 分享链接 */
function CampaignDetail({
  campaign,
  onBack,
  onChanged
}: {
  campaign: Campaign
  onBack: () => void
  onChanged: () => Promise<void>
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
              return (
                <li key={l.token} className={l.active ? '' : 'off'}>
                  <div className="link-main">
                    <span className="link-label">{l.label || t('campaign.unnamed')}</span>
                    <code className="link-url">{url}</code>
                  </div>
                  <span className="link-state">
                    {l.revoked
                      ? t('campaign.revoked')
                      : l.expiresAt
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
                  {l.active && (
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
                  )}
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
function EntryLinkPanel({ accounts }: { accounts: AccountOption[] }): React.JSX.Element {
  const { t } = useI18n()
  const [accountKey, setAccountKey] = useState(accounts[0]?.key ?? '')
  const [handle, setHandle] = useState('')
  const [code, setCode] = useState('')
  const [greeting, setGreeting] = useState(DEFAULT_GREETING)
  const [copied, setCopied] = useState(false)

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
