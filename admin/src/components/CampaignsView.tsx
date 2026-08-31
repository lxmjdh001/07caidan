import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import type {
  ApiClient,
  Campaign,
  CampaignLink,
  CampaignStats,
  FanLibrary
} from '../api'

interface Props {
  client: ApiClient
}

function fmt(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function fmtDuration(sec: number | null): string {
  if (sec === null) return '—'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  return `${(sec / 3600).toFixed(1)}h`
}

/**
 * 引流工单（后台视角）。
 *
 * 工单的创建与判重规则由老板在客户端配置 —— 那里才知道有哪些账号。
 * 后台只做两件事：看统计、管分享链接。刻意不提供创建入口，
 * 避免两边各建一份口径不一致的工单。
 */
export function CampaignsView({ client }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [libraries, setLibraries] = useState<FanLibrary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [shareDomain, setShareDomain] = useState('')
  const [domainSaving, setDomainSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const [c, l, d] = await Promise.all([client.listCampaigns(), client.listLibraries(), client.campaignShareDomain()])
      setCampaigns(c.campaigns)
      setLibraries(l.libraries)
      setShareDomain(d.domain)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  const active = campaigns.find((c) => c.id === activeId) ?? null

  return (
    <div className="view">
      <header className="view-header">
        <h1>{t('campaign.title')}</h1>
        <button className="ghost" onClick={() => void load()}>
          {t('common.refresh')}
        </button>
      </header>

      {err && <p className="err">{err}</p>}
      {loading && <p className="muted">{t('common.loading')}</p>}

      {!loading && (
        <div className="campaign-layout">
          <section className="card campaign-share-domain-card">
            <h3>{t('campaign.shareDomain')}</h3>
            <p className="muted small">{t('campaign.shareDomainHint')}</p>
            <div className="share-domain-form">
              <input value={shareDomain} placeholder={t('campaign.shareDomainPlaceholder')} onChange={(e) => setShareDomain(e.target.value)} />
              <button className="primary" disabled={domainSaving || !shareDomain.trim()} onClick={async () => { setDomainSaving(true); try { const r = await client.updateCampaignShareDomain(shareDomain.trim()); setShareDomain(r.domain); window.alert(t('campaign.shareDomainSaved')) } catch (e) { setErr((e as Error).message) } finally { setDomainSaving(false) } }}>{t('common.save')}</button>
            </div>
          </section>
          <aside className="campaign-side">
            <h3>{t('campaign.list')}</h3>
            {campaigns.length === 0 ? (
              <p className="muted small">
                {t('campaign.emptyHint')}
              </p>
            ) : (
              <ul className="campaign-list">
                {campaigns.map((c) => (
                  <li key={c.id}>
                    <button
                      className={activeId === c.id ? 'on' : ''}
                      onClick={() => setActiveId(c.id)}
                    >
                      <span className="cl-name">{c.name}</span>
                      <span className="cl-meta">
                        {c.accountIds.length} {t('campaign.accountsUnit')} ·{' '}
                        {c.endAt ? `${t('campaign.until')} ${fmt(c.endAt)}` : t('campaign.ongoing')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <h3 style={{ marginTop: 20 }}>{t('campaign.libraries')}</h3>
            {libraries.length === 0 ? (
              <p className="muted small">{t('campaign.emptyLibs')}</p>
            ) : (
              <ul className="lib-list">
                {libraries.map((l) => (
                  <li key={l.id}>
                    <span className="lib-name">{l.name}</span>
                    <span className="muted small">
                      {l.channel} · {l.entryCount} {t('campaign.entries')} ·{' '}
                      {l.source === 'export' ? t('campaign.fromExport') : t('campaign.fromImport')}
                    </span>
                    <button
                      className="danger small"
                      onClick={async () => {
                        if (!window.confirm(t('campaign.deleteLibConfirm'))) return
                        await client.deleteLibrary(l.id)
                        await load()
                      }}
                    >
                      {t('common.delete')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="campaign-main">
            {active ? (
              <CampaignDetail client={client} campaign={active} />
            ) : (
              <p className="muted">{t('campaign.pick')}</p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function CampaignDetail({
  client,
  campaign
}: {
  client: ApiClient
  campaign: Campaign
}): React.JSX.Element {
  const { t } = useI18n()
  const [stats, setStats] = useState<CampaignStats | null>(null)
  const [links, setLinks] = useState<CampaignLink[]>([])
  const [publicBase, setPublicBase] = useState('')
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState('')

  const refresh = useCallback(async () => {
    setErr('')
    try {
      const [s, l] = await Promise.all([
        client.campaignStats(campaign.id),
        client.listLinks(campaign.id)
      ])
      setStats(s.stats)
      setLinks(l.links)
      setPublicBase(l.publicBase)
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [client, campaign.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <>
      <header className="view-header">
        <h2>{campaign.name}</h2>
        <span className="muted small">
          {fmt(campaign.startAt)} {t('campaign.since')} ·{' '}
          {campaign.endAt ? `${t('campaign.until')} ${fmt(campaign.endAt)}` : t('campaign.ongoing')}
        </span>
      </header>

      {err && <p className="err">{err}</p>}

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
              <span className="k">{t('campaign.medianReply')}</span>
              <span className="v small">{fmtDuration(stats.response.medianFirstReplySec)}</span>
            </div>
          </div>

          <section className="card">
            <h3>{t('campaign.dedupTitle')}</h3>
            <p className="muted small">
              {t('campaign.dedupDetail', {
                lib: stats.duplicateBy.library,
                time: stats.duplicateBy.timeRange
              })}
            </p>
          </section>

          <section className="card">
            <h3>{t('campaign.byAccount')}</h3>
            {stats.byAccount.length === 0 ? (
              <p className="muted small">{t('common.empty')}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('campaign.account')}</th>
                    <th>{t('campaign.platform')}</th>
                    <th className="num">{t('campaign.inbound')}</th>
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
            )}
          </section>

          <section className="card">
            <h3>{t('campaign.bySource')}</h3>
            {stats.bySource.length === 0 ? (
              <p className="muted small">{t('common.empty')}</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('campaign.source')}</th>
                    <th>{t('campaign.sourceVia')}</th>
                    <th className="num">{t('campaign.inbound')}</th>
                    <th className="num">{t('campaign.fresh')}</th>
                    <th className="num">{t('campaign.duplicate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.bySource.map((r) => (
                    <tr key={r.code || '__none__'}>
                      <td>{r.code || <span className="muted">{t('campaign.noSource')}</span>}</td>
                      <td>{r.via === 'ad' ? t('campaign.viaAd') : r.via === 'code' ? t('campaign.viaCode') : '—'}</td>
                      <td className="num">{r.total}</td>
                      <td className="num">{r.fresh}</td>
                      <td className="num">{r.duplicate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card">
            <h3>{t('campaign.byDay')}</h3>
            <Trend days={stats.byDay} />
          </section>
        </>
      )}

      <section className="card">
        <h3>{t('campaign.links')}</h3>
        <p className="muted small">
          {t('campaign.linksHint')}
        </p>
        <button
          className="primary"
          onClick={async () => {
            await client.createLink(campaign.id, {})
            await refresh()
          }}
        >
          {t('campaign.newLink')}
        </button>
        {links.length === 0 ? (
          <p className="muted small">{t('campaign.noLinks')}</p>
        ) : (
          <ul className="link-list">
            {links.map((l) => {
              const url = `${publicBase}/c/${l.token}`
              return (
                <li key={l.token} className={l.active ? '' : 'off'}>
                  <div className="link-main">
                    <span className="link-label">{l.label || t('campaign.unnamed')}</span>
                    <code>{url}</code>
                  </div>
                  <span className="muted small">
                    {l.revoked
                      ? t('campaign.revoked')
                      : l.expiresAt
                        ? l.active
                          ? `${fmt(l.expiresAt)} ${t('campaign.expiresAt')}`
                          : t('campaign.expired')
                        : t('campaign.never')}
                  </span>
                  <button
                    className="ghost small"
                    onClick={() => {
                      void navigator.clipboard.writeText(url)
                      setCopied(l.token)
                      setTimeout(() => setCopied(''), 1500)
                    }}
                  >
                    {copied === l.token ? t('common.copied') : t('common.copy')}
                  </button>
                  {l.active && (
                    <button
                      className="danger small"
                      onClick={async () => {
                        await client.revokeLink(l.token)
                        await refresh()
                      }}
                    >
                      {t('campaign.revoke')}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </>
  )
}

/** 纯 CSS 柱状图，避免为一张小图引入图表库 */
function Trend({ days }: { days: CampaignStats['byDay'] }): React.JSX.Element {
  const { t } = useI18n()
  if (days.length === 0) return <p className="muted small">{t('common.empty')}</p>
  const max = Math.max(1, ...days.map((d) => d.total))
  return (
    <>
      <div className="bars">
        {days.map((d, i) => (
          <div
            key={d.date}
            className="bar-col"
            title={`${d.date}：${t('campaign.fresh')} ${d.fresh} / ${t('campaign.duplicate')} ${d.duplicate}`}
          >
            <div className="bar dup" style={{ height: `${(d.duplicate / max) * 100}px` }} />
            <div className="bar fresh" style={{ height: `${(d.fresh / max) * 100}px` }} />
            <span className="bar-x">
              {days.length <= 10 || i === 0 || i === days.length - 1 || i % 7 === 0
                ? d.date.slice(5)
                : ''}
            </span>
          </div>
        ))}
      </div>
      <div className="legend">
        <span>
          <i className="dot fresh" />
          {t('campaign.fresh')}
        </span>
        <span>
          <i className="dot dup" />
          {t('campaign.duplicate')}
        </span>
      </div>
    </>
  )
}
