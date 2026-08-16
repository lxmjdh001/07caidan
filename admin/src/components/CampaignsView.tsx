import { useCallback, useEffect, useState } from 'react'
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
  if (sec < 60) return `${sec} 秒`
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`
  return `${(sec / 3600).toFixed(1)} 小时`
}

/**
 * 引流工单（后台视角）。
 *
 * 工单的创建与判重规则由老板在客户端配置 —— 那里才知道有哪些账号。
 * 后台只做两件事：看统计、管分享链接。刻意不提供创建入口，
 * 避免两边各建一份口径不一致的工单。
 */
export function CampaignsView({ client }: Props): React.JSX.Element {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [libraries, setLibraries] = useState<FanLibrary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const [c, l] = await Promise.all([client.listCampaigns(), client.listLibraries()])
      setCampaigns(c.campaigns)
      setLibraries(l.libraries)
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
        <h1>引流工单</h1>
        <button className="ghost" onClick={() => void load()}>
          刷新
        </button>
      </header>

      {err && <p className="err">{err}</p>}
      {loading && <p className="muted">加载中…</p>}

      {!loading && (
        <div className="campaign-layout">
          <aside className="campaign-side">
            <h3>工单</h3>
            {campaigns.length === 0 ? (
              <p className="muted small">
                还没有工单。工单在客户端创建（选账号、配判重规则），这里只看统计与管分享链接。
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
                        {c.accountIds.length} 个账号 ·{' '}
                        {c.endAt ? `至 ${fmt(c.endAt)}` : '持续进行中'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <h3 style={{ marginTop: 20 }}>重粉库</h3>
            {libraries.length === 0 ? (
              <p className="muted small">暂无重粉库。</p>
            ) : (
              <ul className="lib-list">
                {libraries.map((l) => (
                  <li key={l.id}>
                    <span className="lib-name">{l.name}</span>
                    <span className="muted small">
                      {l.channel} · {l.entryCount} 条 ·{' '}
                      {l.source === 'export' ? '历史导出' : '名单导入'}
                    </span>
                    <button
                      className="danger small"
                      onClick={async () => {
                        if (!window.confirm('删除该重粉库？引用它的工单判重规则会失效。')) return
                        await client.deleteLibrary(l.id)
                        await load()
                      }}
                    >
                      删除
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
              <p className="muted">选择左侧工单查看统计。</p>
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
          {fmt(campaign.startAt)} 起 ·{' '}
          {campaign.endAt ? `至 ${fmt(campaign.endAt)}` : '持续进行中'}
        </span>
      </header>

      {err && <p className="err">{err}</p>}

      {stats && (
        <>
          <div className="stat-cards">
            <div className="stat-card">
              <span className="k">进线总数</span>
              <span className="v">{stats.total}</span>
            </div>
            <div className="stat-card">
              <span className="k">新粉</span>
              <span className="v fresh">{stats.fresh}</span>
            </div>
            <div className="stat-card">
              <span className="k">重复</span>
              <span className="v dup">{stats.duplicate}</span>
            </div>
            <div className="stat-card">
              <span className="k">回复率</span>
              <span className="v">{Math.round(stats.response.replyRate * 100)}%</span>
            </div>
            <div className="stat-card">
              <span className="k">首响中位数</span>
              <span className="v small">{fmtDuration(stats.response.medianFirstReplySec)}</span>
            </div>
          </div>

          <section className="card">
            <h3>判重口径</h3>
            <p className="muted small">
              重粉库命中 {stats.duplicateBy.library} 人 · 时间范围命中{' '}
              {stats.duplicateBy.timeRange} 人（满足任一即算重复，故两者之和可能大于重复总数）
            </p>
          </section>

          <section className="card">
            <h3>账号明细</h3>
            {stats.byAccount.length === 0 ? (
              <p className="muted small">暂无数据</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>账号</th>
                    <th>平台</th>
                    <th className="num">进线</th>
                    <th className="num">新粉</th>
                    <th className="num">重复</th>
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
            <h3>每日趋势</h3>
            <Trend days={stats.byDay} />
          </section>
        </>
      )}

      <section className="card">
        <h3>分享链接</h3>
        <p className="muted small">
          看板只展示统计数字，不含聊天内容与客户信息，可以放心发给团队。
        </p>
        <button
          className="primary"
          onClick={async () => {
            await client.createLink(campaign.id, {})
            await refresh()
          }}
        >
          生成永久链接
        </button>
        {links.length === 0 ? (
          <p className="muted small">还没有分享链接。</p>
        ) : (
          <ul className="link-list">
            {links.map((l) => {
              const url = `${publicBase}/c/${l.token}`
              return (
                <li key={l.token} className={l.active ? '' : 'off'}>
                  <div className="link-main">
                    <span className="link-label">{l.label || '未命名'}</span>
                    <code>{url}</code>
                  </div>
                  <span className="muted small">
                    {l.revoked
                      ? '已停用'
                      : l.expiresAt
                        ? l.active
                          ? `${fmt(l.expiresAt)} 到期`
                          : '已过期'
                        : '永不过期'}
                  </span>
                  <button
                    className="ghost small"
                    onClick={() => {
                      void navigator.clipboard.writeText(url)
                      setCopied(l.token)
                      setTimeout(() => setCopied(''), 1500)
                    }}
                  >
                    {copied === l.token ? '已复制' : '复制'}
                  </button>
                  {l.active && (
                    <button
                      className="danger small"
                      onClick={async () => {
                        await client.revokeLink(l.token)
                        await refresh()
                      }}
                    >
                      停用
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
  if (days.length === 0) return <p className="muted small">暂无数据</p>
  const max = Math.max(1, ...days.map((d) => d.total))
  return (
    <>
      <div className="bars">
        {days.map((d, i) => (
          <div
            key={d.date}
            className="bar-col"
            title={`${d.date}：新粉 ${d.fresh} / 重复 ${d.duplicate}`}
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
          新粉
        </span>
        <span>
          <i className="dot dup" />
          重复
        </span>
      </div>
    </>
  )
}
