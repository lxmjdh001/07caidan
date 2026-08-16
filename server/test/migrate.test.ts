import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import BetterSqlite3 from 'better-sqlite3'
import { CampaignRepo } from '../src/campaign-repo.ts'
import { openDb } from '../src/db.ts'

let dir: string

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-migrate-'))
})
after(() => rmSync(dir, { recursive: true, force: true }))

function columns(path: string, table: string): string[] {
  const db = new BetterSqlite3(path)
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  db.close()
  return rows.map((r) => r.name)
}

describe('增量迁移', () => {
  /**
   * 这个用例存在的原因：CREATE TABLE IF NOT EXISTS 对已存在的表毫无作用，
   * 新列只会出现在全新库上。老库升级后一查就是 no such column —— 实测踩过。
   */
  test('老库缺少后加的列时，打开即自动补上', () => {
    const path = join(dir, 'old.db')

    // 造一个「旧版本」的库：campaigns 表没有 account_labels / dedup_account_ids
    const legacy = new BetterSqlite3(path)
    legacy.exec(`
      CREATE TABLE campaigns (
        tenant TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
        account_ids TEXT NOT NULL DEFAULT '[]',
        start_at INTEGER NOT NULL, end_at INTEGER,
        dedup_library_ids TEXT NOT NULL DEFAULT '[]', dedup_before_at INTEGER,
        created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (tenant, id)
      );
      INSERT INTO campaigns (tenant, id, name, start_at, created_at, updated_at)
      VALUES ('t1', 'old-1', '旧工单', 1000, 1000, 1000);
    `)
    legacy.close()

    const before = columns(path, 'campaigns')
    assert.equal(before.includes('account_labels'), false)

    const db = openDb(path)

    const after = columns(path, 'campaigns')
    assert.equal(after.includes('account_labels'), true)
    assert.equal(after.includes('dedup_account_ids'), true)
    assert.equal(after.includes('tz_offset_minutes'), true)

    // 迁移不能丢数据，且新列要有可用的默认值
    const repo = new CampaignRepo(db)
    const rows = repo.listCampaigns('t1')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.name, '旧工单')
    assert.deepEqual(rows[0]!.accountLabels, {})
    assert.deepEqual(rows[0]!.dedupAccountIds, [])
    assert.equal(rows[0]!.tzOffsetMinutes, 480)
  })

  test('重复打开同一个库不会重复 ALTER（幂等）', () => {
    const path = join(dir, 'twice.db')
    openDb(path)
    openDb(path)
    const cols = columns(path, 'campaigns')
    assert.equal(cols.filter((c) => c === 'account_labels').length, 1)
  })

  test('全新库直接建出完整表结构', () => {
    const path = join(dir, 'fresh.db')
    openDb(path)
    const cols = columns(path, 'campaigns')
    for (const c of ['account_labels', 'dedup_account_ids', 'tz_offset_minutes']) {
      assert.equal(cols.includes(c), true, `缺列 ${c}`)
    }
  })
})
