import { createHash, randomBytes } from 'node:crypto'
import type { AccountConfig, AccountFingerprint } from '@shared/settings'

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 新账号在任何平台登录前生成随机、稳定且互不共用的设备身份。 */
export function createAccountFingerprint(accountKey: string, now = Date.now()): AccountFingerprint {
  return fingerprintFromSeed(accountKey, randomBytes(32).toString('hex'), now)
}

/**
 * 老账号升级时以原 accountId 作为 seed，保持 WhatsApp / Telegram 旧版已经使用的
 * 设备标识不变；只把此前隐式存在的身份显式写进配置。
 */
export function createLegacyAccountFingerprint(accountKey: string, now = Date.now()): AccountFingerprint {
  const separator = accountKey.indexOf(':')
  const accountId = separator >= 0 ? accountKey.slice(separator + 1) : accountKey
  return fingerprintFromSeed(accountKey, accountId || accountKey, now)
}

export function ensureAccountFingerprint(
  accountKey: string,
  config: AccountConfig,
  now = Date.now()
): AccountConfig {
  if (validFingerprint(config.fingerprint)) return config
  return { ...config, fingerprint: createLegacyAccountFingerprint(accountKey, now) }
}

export function fingerprintFromSeed(
  accountKey: string,
  seed: string,
  createdAt = Date.now()
): AccountFingerprint {
  const fingerprintId = digest(`${accountKey}\u0000${seed}`).slice(0, 16).toUpperCase()
  return {
    id: `FP-${fingerprintId}`,
    seed,
    deviceName: `Omni-${fingerprintId.slice(0, 8)}`,
    createdAt
  }
}

export function validFingerprint(value: AccountFingerprint | undefined): value is AccountFingerprint {
  return Boolean(
    value &&
    /^FP-[A-F0-9]{16}$/.test(value.id) &&
    value.seed.length >= 3 &&
    value.deviceName.trim() &&
    Number.isFinite(value.createdAt)
  )
}
