import { describe, expect, it } from 'vitest'
import {
  createAccountFingerprint,
  createLegacyAccountFingerprint,
  ensureAccountFingerprint,
  fingerprintFromSeed,
  validFingerprint
} from './account-fingerprint'

describe('账号设备指纹', () => {
  it('同一 seed 稳定，不同账号/seed 不共用身份', () => {
    expect(fingerprintFromSeed('whatsapp:a1', 'seed', 1)).toEqual(
      fingerprintFromSeed('whatsapp:a1', 'seed', 1)
    )
    expect(fingerprintFromSeed('whatsapp:a1', 'seed', 1).id).not.toBe(
      fingerprintFromSeed('whatsapp:a2', 'seed', 1).id
    )
    expect(fingerprintFromSeed('whatsapp:a1', 'seed-2', 1).id).not.toBe(
      fingerprintFromSeed('whatsapp:a1', 'seed', 1).id
    )
  })

  it('新账号使用随机 seed', () => {
    const first = createAccountFingerprint('line:a1', 123)
    const second = createAccountFingerprint('line:a1', 123)
    expect(first.id).not.toBe(second.id)
    expect(first.createdAt).toBe(123)
    expect(validFingerprint(first)).toBe(true)
  })

  it('老账号显式化后仍使用原 accountId 作为设备派生 seed', () => {
    const legacy = createLegacyAccountFingerprint('telegram:tg123', 456)
    expect(legacy.seed).toBe('tg123')
    expect(ensureAccountFingerprint('telegram:tg123', {}, 456).fingerprint).toEqual(legacy)
    expect(ensureAccountFingerprint('telegram:tg123', { fingerprint: legacy }, 999).fingerprint).toEqual(legacy)
  })
})
