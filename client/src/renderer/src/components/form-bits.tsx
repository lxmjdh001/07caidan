import { useMemo, useState } from 'react'
import { useI18n } from '../i18n'

/** 本地时间 → <input type="datetime-local"> 需要的格式 */
export function toLocalInput(ts: number): string {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}

export function fromLocalInput(v: string): number | undefined {
  if (!v) return undefined
  const ts = new Date(v).getTime()
  return Number.isNaN(ts) ? undefined : ts
}

/** 当天零点（本地时区） */
export function startOfDay(offsetDays = 0): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + offsetDays)
  return d.getTime()
}

export interface DatePreset {
  label: string
  /** 返回 undefined 表示清空 */
  value: () => number | undefined
}

/**
 * 时间选择：输入框 + 一排快捷按钮。
 * 打粉场景里时间几乎总是「今天开始」「30 天前之前的算老粉」这种整数关系，
 * 让用户手动敲 2026-08-16T00:00 又慢又容易点错分钟。
 */
export function DateField({
  label,
  hint,
  value,
  presets,
  onChange
}: {
  label: string
  hint?: string
  value: string
  presets: DatePreset[]
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <div className="field date-field">
      <span>{label}</span>
      <input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} />
      <div className="chip-row">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            className="chip"
            onClick={() => {
              const v = p.value()
              onChange(v === undefined ? '' : toLocalInput(v))
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  )
}

export interface CheckOption {
  value: string
  label: string
  /** 右侧灰色副标题（平台、条数等） */
  sub?: string
}

/**
 * 多选网格，带全选/清空与搜索。
 * 账号动辄几十上百个，没有搜索和全选就没法用。
 */
export function CheckGrid({
  label,
  hint,
  options,
  selected,
  emptyText,
  onChange
}: {
  label: string
  hint?: string
  options: CheckOption[]
  selected: string[]
  emptyText?: string
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
    )
  }, [options, query])

  const toggle = (v: string): void =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])

  // 全选只作用于当前筛选结果，否则搜索后点全选会把看不见的也选上
  const allShownPicked =
    filtered.length > 0 && filtered.every((o) => selected.includes(o.value))

  return (
    <div className="field check-field">
      <div className="check-head">
        <span>{label}</span>
        <span className="check-count">
          {selected.length}/{options.length}
        </span>
        <button
          type="button"
          className="chip"
          disabled={filtered.length === 0}
          onClick={() =>
            onChange(
              allShownPicked
                ? selected.filter((v) => !filtered.some((o) => o.value === v))
                : [...new Set([...selected, ...filtered.map((o) => o.value)])]
            )
          }
        >
          {allShownPicked ? t('form.clearAll') : t('form.selectAll')}
        </button>
      </div>

      {options.length > 8 && (
        <input
          type="text"
          className="check-search"
          value={query}
          placeholder={t('form.search')}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {options.length === 0 ? (
        <p className="field-hint">{emptyText ?? t('form.noOptions')}</p>
      ) : filtered.length === 0 ? (
        <p className="field-hint">{t('form.noMatch')}</p>
      ) : (
        <div className="check-grid">
          {filtered.map((o) => (
            <label key={o.value} className="check-item">
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => toggle(o.value)}
              />
              <span className="check-label">{o.label}</span>
              {o.sub && <span className="check-sub">{o.sub}</span>}
            </label>
          ))}
        </div>
      )}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  )
}
