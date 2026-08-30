import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  computeCampaignStats,
  dayKey,
  fillDays,
  isDuplicate,
  median,
  normalizeResetTime,
  resetBoundaryAt,
  type LeadRow
} from '../src/campaign-stats.ts'

/** 2026-08-16 00:00 UTC+8 */
const T0 = Date.UTC(2026, 7, 15, 16, 0, 0)
const HOUR = 3600_000

function lead(o: Partial<LeadRow> = {}): LeadRow {
  return {
    contactId: `wa:+${Math.random().toString().slice(2, 12)}`,
    channel: 'whatsapp',
    accountId: 'a1',
    firstAt: T0 + HOUR,
    ...o
  }
}

function compute(leads: LeadRow[], o: Partial<Parameters<typeof computeCampaignStats>[0]> = {}) {
  return computeCampaignStats({
    leads,
    rules: { libraryIds: [] },
    libraryContacts: new Set(),
    earliestEverAt: new Map(),
    ...o
  })
}

describe('dayKey', () => {
  test('按 UTC+8 归日：UTC 16:00 已经是次日', () => {
    assert.equal(dayKey(T0, 480), '2026-08-16')
    assert.equal(dayKey(T0, 0), '2026-08-15')
  })
  test('跨月边界', () => {
    assert.equal(dayKey(Date.UTC(2026, 7, 31, 16, 0, 0), 480), '2026-09-01')
  })
  test('负偏移（UTC 以西）：同一瞬间归到更早的日期', () => {
    // 2026-08-16 20:00 UTC：UTC+8 已是 17 号，纽约(UTC-4/夏令 -240)仍是 16 号
    const ts = Date.UTC(2026, 7, 16, 20, 0, 0)
    assert.equal(dayKey(ts, 480), '2026-08-17') // 曼谷/新加坡次日凌晨
    assert.equal(dayKey(ts, -300), '2026-08-16') // 美东标准时同一天
    // 凌晨时段：UTC 02:00，UTC-5 归到前一天
    const ts2 = Date.UTC(2026, 7, 16, 2, 0, 0)
    assert.equal(dayKey(ts2, 480), '2026-08-16')
    assert.equal(dayKey(ts2, -300), '2026-08-15')
  })
})

describe('每日置零时间', () => {
  test('规范化 HH:mm，非法值回落到零点', () => {
    assert.equal(normalizeResetTime('12:00'), '12:00')
    assert.equal(normalizeResetTime('7:05'), '07:05')
    assert.equal(normalizeResetTime('24:00'), '00:00')
    assert.equal(normalizeResetTime('bad'), '00:00')
  })

  test('按工单时区计算当前统计日边界', () => {
    const before = T0 + 11 * HOUR + 59 * 60_000
    const after = T0 + 12 * HOUR + 1_000
    assert.equal(resetBoundaryAt(before, 480, '12:00'), T0 - 12 * HOUR)
    assert.equal(resetBoundaryAt(after, 480, '12:00'), T0 + 12 * HOUR)
  })
})

describe('fillDays 按工单时区补空白天', () => {
  test('同一绝对窗口，不同时区归到不同日期', () => {
    // 08-16 20:00 → 08-17 03:00 UTC（7 小时窗口）
    const startAt = Date.UTC(2026, 7, 16, 20, 0, 0)
    const endAt = Date.UTC(2026, 7, 17, 3, 0, 0)
    // 纽约(UTC-5) 视角整段都在 08-16
    assert.deepEqual(
      fillDays([], startAt, endAt, -300).map((d) => d.date),
      ['2026-08-16']
    )
    // 北京(UTC+8) 视角整段都在 08-17
    assert.deepEqual(
      fillDays([], startAt, endAt, 480).map((d) => d.date),
      ['2026-08-17']
    )
  })

  test('多天窗口按时区逐日补齐，不漏不重', () => {
    const startAt = Date.UTC(2026, 7, 16, 12, 0, 0)
    const endAt = Date.UTC(2026, 7, 18, 12, 0, 0)
    assert.deepEqual(
      fillDays([], startAt, endAt, 480).map((d) => d.date),
      ['2026-08-16', '2026-08-17', '2026-08-18']
    )
  })
})

describe('median', () => {
  test('空集为 null', () => assert.equal(median([]), null))
  test('奇数取中间', () => assert.equal(median([5, 1, 3]), 3))
  test('偶数取两者均值并取整', () => assert.equal(median([1, 2, 3, 4]), 3))
})

describe('isDuplicate', () => {
  test('没配任何规则 → 都是新粉', () => {
    const r = isDuplicate({ libraryIds: [] }, true, 1)
    assert.equal(r.duplicate, false)
  })
  test('选了库且命中 → 重复', () => {
    const r = isDuplicate({ libraryIds: ['L1'] }, true, undefined)
    assert.deepEqual([r.duplicate, r.byLibrary, r.byTimeRange], [true, true, false])
  })
  test('选了库但没命中 → 新粉', () => {
    assert.equal(isDuplicate({ libraryIds: ['L1'] }, false, undefined).duplicate, false)
  })
  test('时间规则：更早出现过 → 重复', () => {
    const r = isDuplicate({ libraryIds: [], beforeAt: 1000 }, false, 999)
    assert.deepEqual([r.duplicate, r.byTimeRange], [true, true])
  })
  test('时间规则：正好等于分界点不算重复', () => {
    assert.equal(isDuplicate({ libraryIds: [], beforeAt: 1000 }, false, 1000).duplicate, false)
  })
  test('两条规则取并集：命中任一即重复', () => {
    const r = isDuplicate({ libraryIds: ['L1'], beforeAt: 1000 }, true, 5000)
    assert.deepEqual([r.duplicate, r.byLibrary, r.byTimeRange], [true, true, false])
  })
})

describe('computeCampaignStats', () => {
  test('空工单不炸，回复率为 0 而不是 NaN', () => {
    const s = compute([])
    assert.equal(s.total, 0)
    assert.equal(s.response.replyRate, 0)
    assert.equal(s.response.medianFirstReplySec, null)
  })

  test('新粉 = 总数 - 重复；有效等于新粉（联系即有效）', () => {
    const leads = [
      lead({ contactId: 'wa:+1' }),
      lead({ contactId: 'wa:+2' }),
      lead({ contactId: 'wa:+3' })
    ]
    const s = compute(leads, {
      rules: { libraryIds: ['L1'] },
      libraryContacts: new Set(['wa:+2'])
    })
    assert.equal(s.total, 3)
    assert.equal(s.duplicate, 1)
    assert.equal(s.fresh, 2)
    assert.equal(s.effective, 2)
    assert.deepEqual(s.duplicateBy, { library: 1, timeRange: 0 })
  })

  test('today 按置零时间统计，而不是固定自然日', () => {
    const s = compute(
      [
        lead({ contactId: 'wa:+before', firstAt: T0 + 11 * HOUR }),
        lead({ contactId: 'wa:+after', firstAt: T0 + 13 * HOUR })
      ],
      { todayStartAt: T0 + 12 * HOUR, now: T0 + 14 * HOUR }
    )
    assert.deepEqual(s.today, { total: 1, duplicate: 0, fresh: 1 })
  })

  test('同工单跨账号的后续进线计为重复，但仍计入申请数', () => {
    const s = compute([
      lead({ contactId: 'wa:+1', accountId: 'a1' }),
      lead({ contactId: 'wa:+1', accountId: 'a2', campaignDuplicate: true })
    ])
    assert.equal(s.total, 2)
    assert.equal(s.fresh, 1)
    assert.equal(s.duplicate, 1)
    assert.deepEqual(
      s.byAccount.map((row) => [row.accountId, row.total, row.fresh, row.duplicate]),
      [
        ['a1', 1, 1, 0],
        ['a2', 1, 0, 1]
      ]
    )
  })

  test('跨平台隔离：WhatsApp 线索不被含同号码的 Telegram 库判为重复', () => {
    // 平台隔离靠带前缀身份自然分割：wa: 与 tg: 字符串不相等 → 规则 A 不匹配。
    // 否则同一号码跨平台会被误判重复，错误压低「有效」数——老板据此结算引流成效，
    // 属钱相关红线。（channelOfContactId 是为此写的校验函数，实际靠前缀自隔离，未接线。）
    const s = compute([lead({ contactId: 'wa:+8613800138000' })], {
      rules: { libraryIds: ['L1'] },
      libraryContacts: new Set(['tg:8613800138000'])
    })
    assert.equal(s.total, 1)
    assert.equal(s.duplicate, 0, '跨平台库不得命中')
    assert.equal(s.fresh, 1)
    assert.equal(s.effective, 1)
  })

  test('同一客户同时命中两种规则只计一次重复，但原因各记一次', () => {
    const s = compute([lead({ contactId: 'wa:+1' })], {
      rules: { libraryIds: ['L1'], beforeAt: T0 },
      libraryContacts: new Set(['wa:+1']),
      earliestEverAt: new Map([['wa:+1', T0 - HOUR]])
    })
    assert.equal(s.duplicate, 1)
    assert.deepEqual(s.duplicateBy, { library: 1, timeRange: 1 })
  })

  test('按账号拆分，归属首次接触的账号，按量降序', () => {
    const s = compute([
      lead({ contactId: 'wa:+1', accountId: 'a1' }),
      lead({ contactId: 'wa:+2', accountId: 'a2' }),
      lead({ contactId: 'wa:+3', accountId: 'a2' })
    ])
    assert.equal(s.byAccount.length, 2)
    assert.equal(s.byAccount[0]!.accountId, 'a2')
    assert.equal(s.byAccount[0]!.total, 2)
    assert.equal(s.byAccount[1]!.accountId, 'a1')
  })

  test('账号备注名可以展示（是老板自己的账号）', () => {
    const s = compute([lead({ accountId: 'a1' })], { accountLabels: { a1: '主号' } })
    assert.equal(s.byAccount[0]!.label, '主号')
  })

  test('按天趋势按日期升序', () => {
    const s = compute([
      lead({ contactId: 'wa:+1', firstAt: T0 + HOUR }),
      lead({ contactId: 'wa:+2', firstAt: T0 + 25 * HOUR }),
      lead({ contactId: 'wa:+3', firstAt: T0 + 26 * HOUR })
    ])
    assert.deepEqual(
      s.byDay.map((d) => [d.date, d.total]),
      [
        ['2026-08-16', 1],
        ['2026-08-17', 2]
      ]
    )
  })

  test('响应统计：回复率与首响中位数', () => {
    const s = compute([
      lead({ contactId: 'wa:+1', firstAt: T0, firstReplyAt: T0 + 60_000 }),
      lead({ contactId: 'wa:+2', firstAt: T0, firstReplyAt: T0 + 180_000 }),
      lead({ contactId: 'wa:+3', firstAt: T0, firstReplyAt: T0 + 300_000 }),
      lead({ contactId: 'wa:+4', firstAt: T0 })
    ])
    assert.equal(s.response.replied, 3)
    assert.equal(s.response.replyRate, 0.75)
    assert.equal(s.response.medianFirstReplySec, 180)
  })

  test('回复时间早于进线时间的脏数据不计入响应', () => {
    const s = compute([lead({ firstAt: T0, firstReplyAt: T0 - HOUR })])
    assert.equal(s.response.replied, 0)
    assert.equal(s.response.medianFirstReplySec, null)
  })

  test('统计输出不包含任何粉丝身份信息', () => {
    const s = compute(
      [
        lead({ contactId: 'wa:+8613800138000', firstAt: T0, firstReplyAt: T0 + 1000 }),
        lead({ contactId: 'tg:99887766', firstAt: T0 })
      ],
      { accountLabels: { a1: '主号' } }
    )
    const dumped = JSON.stringify(s)
    // 看板可公开分享：contactId / 手机号 / TG id 一律不得出现
    assert.equal(dumped.includes('8613800138000'), false)
    assert.equal(dumped.includes('99887766'), false)
    assert.equal(dumped.includes('contactId'), false)
    assert.equal(dumped.includes('wa:'), false)
    assert.equal(dumped.includes('tg:'), false)
  })
})

describe('fillDays', () => {
  test('补齐中间没有数据的日期', () => {
    const days = [
      { date: '2026-08-16', total: 2, duplicate: 0, fresh: 2 },
      { date: '2026-08-19', total: 1, duplicate: 1, fresh: 0 }
    ]
    const filled = fillDays(days, T0, T0 + 3 * 24 * HOUR, 480)
    assert.deepEqual(
      filled.map((d) => d.date),
      ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19']
    )
    assert.equal(filled[1]!.total, 0)
    assert.equal(filled[3]!.duplicate, 1)
  })
  test('结束早于开始返回空', () => {
    assert.deepEqual(fillDays([], T0, T0 - 1000), [])
  })
})

describe('按投放来源拆分', () => {
  test('按来源分组并按量降序', () => {
    const s = compute([
      lead({ contactId: 'wa:+1', sourceCode: 'fb01', sourceVia: 'ad' }),
      lead({ contactId: 'wa:+2', sourceCode: 'fb01', sourceVia: 'ad' }),
      lead({ contactId: 'wa:+3', sourceCode: 'tt02', sourceVia: 'code' })
    ])
    assert.deepEqual(
      s.bySource.map((x) => [x.code, x.total, x.via]),
      [
        ['fb01', 2, 'ad'],
        ['tt02', 1, 'code']
      ]
    )
  })

  test('未归因的客户归到空 code 且排最后', () => {
    const s = compute([
      lead({ contactId: 'wa:+1' }),
      lead({ contactId: 'wa:+2' }),
      lead({ contactId: 'wa:+3', sourceCode: 'fb01' })
    ])
    assert.equal(s.bySource[s.bySource.length - 1]!.code, '')
    assert.equal(s.bySource[s.bySource.length - 1]!.total, 2)
  })

  test('各来源人数之和等于总数（未归因也算进去）', () => {
    const s = compute([
      lead({ contactId: 'wa:+1', sourceCode: 'a' }),
      lead({ contactId: 'wa:+2' }),
      lead({ contactId: 'wa:+3', sourceCode: 'b' })
    ])
    assert.equal(
      s.bySource.reduce((n, x) => n + x.total, 0),
      s.total
    )
  })

  test('来源内部也区分新粉与重复', () => {
    const s = compute(
      [
        lead({ contactId: 'wa:+1', sourceCode: 'fb01' }),
        lead({ contactId: 'wa:+2', sourceCode: 'fb01' })
      ],
      { rules: { libraryIds: ['L1'] }, libraryContacts: new Set(['wa:+1']) }
    )
    assert.deepEqual(
      s.bySource.map((x) => [x.code, x.fresh, x.duplicate]),
      [['fb01', 1, 1]]
    )
  })

  test('来源拆分里不含任何客户身份信息', () => {
    const dumped = JSON.stringify(
      compute([lead({ contactId: 'wa:+8613800138000', sourceCode: 'fb01' })]).bySource
    )
    assert.equal(dumped.includes('8613800138000'), false)
    assert.equal(dumped.includes('contactId'), false)
  })
})
