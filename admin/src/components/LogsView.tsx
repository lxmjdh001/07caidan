import { useCallback, useEffect, useState } from 'react'
import type { ApiClient, ClientLogRow, LogDevice } from '../api'
import { useI18n } from '../i18n'

const LEVELS = ['debug', 'info', 'warn', 'error'] as const

const LEVEL_COLOR: Record<string, string> = {
  debug: 'var(--muted)',
  info: 'var(--accent)',
  warn: 'var(--warn)',
  error: 'var(--danger)'
}

/**
 * 客户端日志（M19）：设备/用户概览 + 明细过滤 + 按用户调级别。
 * 排障流程：在概览里找到出问题的用户 → 调到 debug → 让用户复现 → 看明细。
 */
export function LogsView({ client }: { client: ApiClient }): React.JSX.Element {
  const { t } = useI18n()
  const [devices, setDevices] = useState<LogDevice[]>([])
  const [levels, setLevels] = useState<Map<number, string>>(new Map())
  const [logs, setLogs] = useState<ClientLogRow[]>([])
  const [level, setLevel] = useState('warn')
  const [deviceId, setDeviceId] = useState('')
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)

  const reload = useCallback(async () => {
    try {
      const [d, l] = await Promise.all([
        client.listLogDevices(),
        client.listClientLogs({ level, deviceId: deviceId || undefined, q: q || undefined })
      ])
      setDevices(d.devices)
      setLevels(new Map(d.levels.map((x) => [x.userId, x.level])))
      setLogs(l.logs)
      setErr('')
    } catch (e) {
      setErr(String((e as Error).message ?? e))
    }
  }, [client, level, deviceId, q])

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

  return (
    <div className="panel">
      <header className="panel-header">
        <h2>{t('logs.title')}</h2>
      </header>
      {err && <div className="error-banner">{err}</div>}

      <section className="card">
        <h3>{t('logs.devices')}</h3>
        <p className="hint">{t('logs.devicesHint')}</p>
        <table className="table">
          <thead>
            <tr>
              <th>{t('logs.user')}</th>
              <th>{t('logs.device')}</th>
              <th>{t('logs.system')}</th>
              <th>{t('logs.version')}</th>
              <th>{t('logs.lastSeen')}</th>
              <th>{t('logs.errors')}</th>
              <th>{t('logs.level')}</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr
                key={d.deviceId}
                className={deviceId === d.deviceId ? 'row-on' : ''}
                onClick={() => setDeviceId(deviceId === d.deviceId ? '' : d.deviceId)}
                style={{ cursor: 'pointer' }}
              >
                <td>{d.email ?? t('logs.guest')}</td>
                <td title={d.deviceId}>{d.deviceId.slice(0, 8)}…</td>
                <td>
                  {d.osType} {d.osVersion}
                </td>
                <td>{d.appVersion}</td>
                <td>{new Date(d.lastAt).toLocaleString()}</td>
                <td style={{ color: d.errors > 0 ? 'var(--danger)' : undefined }}>
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
                    <span className="hint">warn</span>
                  )}
                </td>
              </tr>
            ))}
            {devices.length === 0 && (
              <tr>
                <td colSpan={7} className="hint">
                  {t('logs.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="toolbar">
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {LEVELS.map((lv) => (
              <option key={lv} value={lv}>
                ≥ {lv}
              </option>
            ))}
          </select>
          <input
            placeholder={t('logs.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {deviceId && (
            <button className="ghost" onClick={() => setDeviceId('')}>
              {t('logs.clearDevice')} {deviceId.slice(0, 8)}…
            </button>
          )}
        </div>
        <table className="table">
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
                <td>{new Date(l.at).toLocaleString()}</td>
                <td style={{ color: LEVEL_COLOR[l.level] }}>{l.level}</td>
                <td>{l.email ?? t('logs.guest')}</td>
                <td>{l.scope}</td>
                <td>
                  {l.message}
                  {expanded === l.id && l.meta && (
                    <pre className="log-meta">{pretty(l.meta)}</pre>
                  )}
                </td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="hint">
                  {t('logs.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
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
