import { createHash } from 'node:crypto'
import os from 'node:os'

/**
 * 硬件派生的设备指纹。
 *
 * 目的：日志上报时把「同一台电脑」归拢到一起（尤其是游客日志），
 * 又不上传任何隐私原文 —— 只上传各硬件特征拼接后的哈希。
 * 特征选择偏稳定项（主机名/平台/架构/CPU 型号/内存总量/首个外网 MAC），
 * 系统升级或换 IP 不会改变指纹；换机器则必然改变。
 */
export function computeDeviceId(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)
}

let cached: string | null = null

export function deviceId(): string {
  if (cached) return cached
  const mac =
    Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && !i.internal && i.mac !== '00:00:00:00:00:00')?.mac ?? ''
  cached = computeDeviceId([
    os.hostname(),
    process.platform,
    os.arch(),
    os.cpus()[0]?.model ?? '',
    String(os.totalmem()),
    mac
  ])
  return cached
}

/** 系统信息（随每批日志上报，管理后台排障用） */
export function osInfo(): { osType: string; osVersion: string } {
  return { osType: process.platform, osVersion: os.release() }
}

/** 人类可读的设备名（远程下线列表里展示，方便用户认出哪台是哪台） */
const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux'
}
export function deviceName(): string {
  return `${os.hostname()} · ${PLATFORM_LABEL[process.platform] ?? process.platform}`
}
