import { useCallback, useEffect, useState } from 'react'
import type { AnnouncementRow, ApiClient, Plan, ReminderSettingsRow } from '../api'
import { useI18n } from '../i18n'

interface Props {
  client: ApiClient
}

const AUDIENCES = ['all', 'plan', 'new_users', 'expiring'] as const

/** 运营公告 + 到期提醒设置 */
export function AnnouncementsView({ client }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [list, setList] = useState<AnnouncementRow[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [err, setErr] = useState('')

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [audience, setAudience] = useState<string>('all')
  const [param, setParam] = useState('')

  const [rs, setRs] = useState<ReminderSettingsRow | null>(null)
  const [vars, setVars] = useState<string[]>([])
  const [days, setDays] = useState('')
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    setErr('')
    try {
      const [a, r] = await Promise.all([client.listAnnouncements(), client.reminderSettings()])
      setList(a.announcements)
      setRs(r.settings)
      setVars(r.vars)
      setDays(r.settings.daysBefore.join(','))
      // 套餐列表可能没权限（只有 announcements:manage 没有 billing:manage），失败不阻塞
      try {
        setPlans((await client.listPlans()).plans)
      } catch {
        setPlans([])
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  const audienceLabel = (a: AnnouncementRow): string => {
    if (a.audience === 'all') return t('ann.aud.all')
    if (a.audience === 'plan') {
      const p = plans.find((x) => x.id === a.audienceParam)
      return `${t('ann.aud.plan')}: ${p?.name ?? a.audienceParam}`
    }
    if (a.audience === 'new_users') return t('ann.aud.new').replace('{n}', a.audienceParam || '7')
    return t('ann.aud.expiring').replace('{n}', a.audienceParam || '7')
  }

  return (
    <div className="view">
      <header className="view-header">
        <h1>{t('ann.title')}</h1>
        <button className="ghost" onClick={() => void load()}>
          {t('common.refresh')}
        </button>
      </header>
      <div className="view-body">
        {err && <p className="err">{err}</p>}

        <section className="card">
          <h3>{t('ann.new')}</h3>
          <div className="form-row">
            <label>
              <span>{t('ann.titleField')}</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ minWidth: 240 }} />
            </label>
            <label>
              <span>{t('ann.audience')}</span>
              <select
                value={audience}
                onChange={(e) => {
                  setAudience(e.target.value)
                  setParam('')
                }}
              >
                {AUDIENCES.map((a) => (
                  <option key={a} value={a}>
                    {t(`ann.audopt.${a}` as 'ann.audopt.all')}
                  </option>
                ))}
              </select>
            </label>
            {audience === 'plan' && (
              <label>
                <span>{t('ann.plan')}</span>
                <select value={param} onChange={(e) => setParam(e.target.value)}>
                  <option value="">--</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(audience === 'new_users' || audience === 'expiring') && (
              <label>
                <span>{t('ann.days')}</span>
                <input value={param} placeholder="7" onChange={(e) => setParam(e.target.value)} style={{ width: 70 }} />
              </label>
            )}
          </div>
          <label className="block-label">
            <span>{t('ann.body')}</span>
            <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <button
            className="primary"
            onClick={async () => {
              setErr('')
              if (!title.trim() || !body.trim()) return setErr(t('ann.errRequired'))
              await client.createAnnouncement({
                title: title.trim(),
                body,
                audience: audience as AnnouncementRow['audience'],
                audienceParam: param
              })
              setTitle('')
              setBody('')
              await load()
            }}
          >
            {t('ann.publish')}
          </button>
        </section>

        <section className="card">
          <h3>{t('ann.list')}</h3>
          {list.length === 0 ? (
            <p className="muted small">{t('common.empty')}</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('ann.titleField')}</th>
                  <th>{t('ann.audience')}</th>
                  <th>{t('billing.enabled')}</th>
                  <th>{t('users.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.id} className={a.enabled ? '' : 'row-off'}>
                    <td title={a.body}>{a.title}</td>
                    <td>{audienceLabel(a)}</td>
                    <td>{a.enabled ? t('billing.enable') : t('billing.disable')}</td>
                    <td>
                      <button
                        className="ghost small"
                        onClick={async () => {
                          await client.updateAnnouncement(a.id, { enabled: !a.enabled })
                          await load()
                        }}
                      >
                        {a.enabled ? t('billing.disable') : t('billing.enable')}
                      </button>{' '}
                      <button
                        className="danger small"
                        onClick={async () => {
                          if (!window.confirm(t('ann.deleteConfirm'))) return
                          await client.deleteAnnouncement(a.id)
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

        {rs && (
          <section className="card">
            <h3>{t('ann.reminder')}</h3>
            <div className="form-row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={rs.enabled}
                  onChange={(e) => setRs({ ...rs, enabled: e.target.checked })}
                />
                <span>{t('ann.remEnabled')}</span>
              </label>
              <label>
                <span>{t('ann.remDays')}</span>
                <input value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 110 }} />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={rs.emailEnabled}
                  onChange={(e) => setRs({ ...rs, emailEnabled: e.target.checked })}
                />
                <span>{t('ann.remEmail')}</span>
              </label>
            </div>
            <label className="block-label">
              <span>{t('ann.remSubject')}</span>
              <input value={rs.emailSubject} onChange={(e) => setRs({ ...rs, emailSubject: e.target.value })} />
            </label>
            <label className="block-label">
              <span>{t('ann.remBody')}</span>
              <textarea rows={5} value={rs.emailBody} onChange={(e) => setRs({ ...rs, emailBody: e.target.value })} />
            </label>
            <p className="muted small">
              {t('ann.remVars')}: {vars.map((v) => `{{${v}}}`).join(' ')}
            </p>
            <div className="form-row">
              <button
                className="primary"
                onClick={async () => {
                  await client.updateReminderSettings({
                    ...rs,
                    daysBefore: days
                      .split(/[,，\s]+/)
                      .map((x) => Number(x))
                      .filter((x) => Number.isFinite(x) && x > 0)
                  })
                  setSaved(true)
                  setTimeout(() => setSaved(false), 1500)
                  await load()
                }}
              >
                {t('common.save')}
              </button>
              {saved && <span className="muted small">✓</span>}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
