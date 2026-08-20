import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { openDb } from '../src/db.ts'
import { LogRepo } from '../src/logs/log-repo.ts'

const T = 'dev-token'
const DEV = { deviceId: 'a1b2c3d4', appVersion: '1.0', osType: 'darwin', osVersion: '14' }
const DAY = 24 * 3600_000
const RETAIN = 14 * DAY

let dir: string
let repo: LogRepo

const entry = (over: Record<string, unknown> = {}) => ({ level: 'warn', scope: 's', message: 'm', at: 1, ...over })

before(() => { dir = mkdtempSync(join(tmpdir(), 'omni-logrepo-')) })
after(() => { rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  repo = new LogRepo(openDb(join(dir, `${Math.random().toString(36).slice(2)}.db`)))
})

describe('LogRepo.prune（14 天保留期清理）', () => {
  test('近期日志保留、模拟到期后清理，返回删除条数', () => {
    assert.equal(repo.ingest(T, undefined, DEV, [entry(), entry(), entry()]), 3)
    // 当下清理：都在保留期内 → 一条不删
    assert.equal(repo.prune(Date.now()), 0)
    assert.equal(repo.list(T).total, 3)
    // 模拟 15 天后清理：createdAt(≈现在) < now-14天 → 全删
    assert.equal(repo.prune(Date.now() + RETAIN + DAY), 3)
    assert.equal(repo.list(T).total, 0)
  })
})

describe('LogRepo.ingest（脏条目跳过）', () => {
  test('非法级别或非字符串正文的条目被跳过，只计合法条数', () => {
    const added = repo.ingest(T, undefined, DEV, [
      entry(), // 合法
      entry({ level: 'bogus' }), // 非法级别 → 跳过
      entry({ message: 123 }), // 正文非字符串 → 跳过
      entry({ level: 'error' }) // 合法
    ])
    assert.equal(added, 2)
    assert.equal(repo.list(T).total, 2)
  })
})
