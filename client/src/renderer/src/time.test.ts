import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatBubbleTime, formatListTime } from './time'

// formatListTime 的三段分桶(今天→时间/昨天→标签/更早→日期)带日界，是每条会话行都显示的时间，
// 却没测过。用固定系统时间锁死各分支与边界(尤其今天/昨天以 startOfToday 为界)。
describe('formatListTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 21, 15, 30, 0)) // 本地 2026-08-21 15:30
  })
  afterEach(() => vi.useRealTimers())

  const YDAY = '昨天'
  const startOfToday = new Date(2026, 7, 21, 0, 0, 0).getTime()

  it('今天的消息 → 显示 HH:MM', () => {
    const out = formatListTime(new Date(2026, 7, 21, 9, 5, 0).getTime(), 'en-US', YDAY)
    expect(out).toMatch(/^\d{2}:\d{2}$/)
  })

  it('恰好今日零点(startOfToday)算今天 → 时间格式，不落到昨天', () => {
    expect(formatListTime(startOfToday, 'en-US', YDAY)).toMatch(/^\d{2}:\d{2}$/)
  })

  it('昨天的消息 → 昨天标签', () => {
    expect(formatListTime(new Date(2026, 7, 20, 12, 0, 0).getTime(), 'en-US', YDAY)).toBe(YDAY)
  })

  it('今日零点前 1ms 仍算昨天 → 昨天标签', () => {
    expect(formatListTime(startOfToday - 1, 'en-US', YDAY)).toBe(YDAY)
  })

  it('前天及更早 → 月/日日期（非时间、非昨天标签）', () => {
    const out = formatListTime(new Date(2026, 7, 19, 12, 0, 0).getTime(), 'en-US', YDAY)
    expect(out).not.toMatch(/^\d{2}:\d{2}$/)
    expect(out).not.toBe(YDAY)
    expect(out).toContain('19') // 含日期 19
  })

  it('ts=0 → 空串', () => {
    expect(formatListTime(0, 'en-US', YDAY)).toBe('')
  })
})

describe('formatBubbleTime', () => {
  it('始终 HH:MM（24 小时）', () => {
    expect(formatBubbleTime(new Date(2026, 7, 21, 9, 5, 0).getTime(), 'en-US')).toMatch(/^\d{2}:\d{2}$/)
  })
})
