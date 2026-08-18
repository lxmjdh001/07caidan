import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, ClientLogRow, LogDevice } from '../api'
import { useI18n } from '../i18n'

const LEVELS = ['debug', 'info', 'warn', 'error'] as const
const PAGE_SIZE = 50

/**
 * 客户端日志（M19）：设备/用户概览 + 明细过滤 + 分页 + 按用户调级别。
 * 排障流程：在概览里找到出问题的用户 → 调到 debug → 让用户复现 → 看明细。
 */
export function LogsView({ client }: { client: ApiClient }): React.JSX.Element {
  const { t } = useI18n()
  const [devices, setDevices] = useState<LogDevice[]>([])
  const [levels, setLevels] = useState<Map<number, string>>(new Map())
  const [logs, setLogs] = useState<ClientLogRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [level, setLevel] = useState('warn')
  const [deviceId, setDeviceId] = useState('')
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)

  const reload = useCallback(async () => {
    try {
      const [d, l] = await Promise.all([
        client.listLogDevices(),
        client.listClientLogs({
          level,
          deviceId: deviceId || undefined,
          q: q || undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE
        })
      ])
      setDevices(d.devices)
      setLevels(new Map(d.levels.map((x) => [x.userId, x.level])))
      setLogs(l.logs)
      setTotal(l.total)
      setErr('')
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }, [client, level, deviceId, q, page])

  useEffect(() => {
    void reload()
  }, [reload])

  const setUserLevel = async (userId: number, lv: string): Promise<void> => {
    try {
      await client.setLogLevel(userId, lv)
      await reload()
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="view">
      <header className="view-header">
        <h1>{t('logs.title')}</h1>
      </header>
      <div className="view-body">
        {err && <p className="err">{err}</p>}

        <section className="card">
          <h3>{t('logs.devices')}</h3>
          <p className="muted small">{t('logs.devicesHint')}</p>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('logs.user')}</th>
                <th>{t('logs.device')}</th>
                <th>{t('logs.system')}</th>
                <th>{t('logs.version')}</th>
                <th>{t('logs.lastSeen')}</th>
                <th className="num">{t('logs.errors')}</th>
                <th>{t('logs.level')}</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr
                  key={d.deviceId}
                  className={deviceId === d.deviceId ? 'row-on' : ''}
                  onClick={() => {
                    setDeviceId(deviceId === d.deviceId ? '' : d.deviceId)
                    setPage(0)
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <td>{d.email ?? t('logs.guest')}</td>
                  <td title={d.deviceId}>
                    <code>{d.deviceId.slice(0, 8)}…</code>
                  </td>
                  <td>
                    {d.osType} {d.osVersion}
                  </td>
                  <td>{d.appVersion}</td>
                  <td>{new Date(d.lastAt).toLocaleString()}</td>
                  <td className="num" style={{ color: d.errors > 0 ? 'var(--danger)' : undefined }}>
                    {d.errors}/{d.total}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {d.userId !== null ? (
                      <select
                        value={levels.get(d.userId) ?? 'warn'}
                        onChange={(e) => void setUserLevel(d.userId!, e.target.value)}
                      >
                        {LEVELS.map((lv) => (
                          <option key={lv} value={lv}>
                            {lv}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted small">warn</span>
                    )}
                  </td>
                </tr>
              ))}
              {devices.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted small">
                    {t('logs.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="log-toolbar">
            <select
              value={level}
              onChange={(e) => {
                setLevel(e.target.value)
                setPage(0)
              }}
            >
              {LEVELS.map((lv) => (
                <option key={lv} value={lv}>
                  ≥ {lv}
                </option>
              ))}
            </select>
            <input
              placeholder={t('logs.search')}
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPage(0)
              }}
            />
            {deviceId && (
              <button
                className="ghost small"
                onClick={() => {
                  setDeviceId('')
                  setPage(0)
                }}
              >
                {t('logs.clearDevice')} {deviceId.slice(0, 8)}…
              </button>
            )}
            <span className="muted small" style={{ marginLeft: 'auto' }}>
              {t('logs.total').replace('{n}', String(total))}
            </span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('logs.time')}</th>
                <th>{t('logs.level')}</th>
                <th>{t('logs.user')}</th>
                <th>{t('logs.scope')}</th>
                <th>{t('logs.message')}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                  style={{ cursor: l.meta ? 'pointer' : undefined }}
                >
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(l.at).toLocaleString()}</td>
                  <td>
                    <span className={`log-level ${l.level}`}>{l.level}</span>
                  </td>
                  <td>{l.email ?? t('logs.guest')}</td>
                  <td>
                    <code>{l.scope}</code>
                  </td>
                  <td>
                    {l.message}
                    {expanded === l.id && l.meta && <pre className="log-meta">{pretty(l.meta)}</pre>}
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted small">
                    {t('logs.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="pager">
            <button className="ghost small" disabled={page === 0} onClick={() => setPage(page - 1)}>
              {t('logs.prev')}
            </button>
            <span>
              {page + 1} / {pages}
            </span>
            <button
              className="ghost small"
              disabled={page + 1 >= pages}
              onClick={() => setPage(page + 1)}
            >
              {t('logs.next')}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

function pretty(meta: string): string {
  try {
    return JSON.stringify(JSON.parse(meta), null, 2)
  } catch {
    return meta
  }
}
