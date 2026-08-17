import { describe, expect, test, vi } from 'vitest'
import { computeDeviceId } from './device-id'
import { LogUploader, teeLogger } from './log-uploader'
import { noopLogger } from './logger'

function makeUploader(overrides: {
  fetchImpl?: typeof fetch
  token?: string
  serverUrl?: string
}): LogUploader {
  return new LogUploader({
    getConfig: () => ({
      serverUrl: overrides.serverUrl ?? 'https://api.test',
      token: overrides.token ?? 'tok'
    }),
    deviceId: 'a'.repeat(32),
    appVersion: '1.0.0',
    osType: 'darwin',
    osVersion: '25.0.0',
    fetchImpl: overrides.fetchImpl
  })
}

function okResponse(body: unknown = { ok: true, level: 'warn' }): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('LogUploader', () => {
  test('默认门槛 warn：debug/info 不进缓冲', () => {
    const up = makeUploader({})
    up.add('debug', 's', 'd')
    up.add('info', 's', 'i')
    up.add('warn', 's', 'w')
    up.add('error', 's', 'e')
    expect(up.pending()).toBe(2)
  })

  test('冲刷成功清空缓冲并携带设备与版本信息', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    const up = makeUploader({ fetchImpl: fetchMock as unknown as typeof fetch })
    up.add('error', 'wa:main', 'boom', new Error('x'))
    await up.flush()
    expect(up.pending()).toBe(0)
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/api/logs')
    const body = JSON.parse(String(init.body))
    expect(body.deviceId).toBe('a'.repeat(32))
    expect(body.appVersion).toBe('1.0.0')
    expect(body.entries[0].message).toBe('boom')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  test('游客（无令牌）不带 authorization 头', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    const up = makeUploader({ fetchImpl: fetchMock as unknown as typeof fetch, token: '' })
    up.add('warn', '', 'guest issue')
    await up.flush()
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  test('网络失败保留缓冲，恢复后重试成功', async () => {
    let fail = true
    const fetchMock = vi.fn(async () => {
      if (fail) throw new Error('offline')
      return okResponse()
    })
    const up = makeUploader({ fetchImpl: fetchMock as unknown as typeof fetch })
    up.add('error', '', 'kept')
    await up.flush()
    expect(up.pending()).toBe(1)
    fail = false
    await up.flush()
    expect(up.pending()).toBe(0)
  })

  test('响应带回 level=debug 后门槛放开', async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, level: 'debug' }))
    const up = makeUploader({ fetchImpl: fetchMock as unknown as typeof fetch })
    up.add('warn', '', 'first')
    await up.flush()
    expect(up.currentLevel()).toBe('debug')
    up.add('debug', '', 'verbose')
    expect(up.pending()).toBe(1)
  })

  test('缓冲超限丢最旧的（不无限吃内存）', () => {
    const up = makeUploader({})
    for (let i = 0; i < 600; i++) up.add('error', '', `m${i}`)
    expect(up.pending()).toBeLessThanOrEqual(500)
  })

  test('未配置后台地址时静默不发', async () => {
    const fetchMock = vi.fn()
    const up = makeUploader({ fetchImpl: fetchMock as unknown as typeof fetch, serverUrl: '' })
    up.add('error', '', 'x')
    await up.flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('teeLogger', () => {
  test('日志同时进本地 logger 与上传器，子作用域拼接', () => {
    const up = makeUploader({})
    const log = teeLogger(noopLogger, up, 'app').child('wa').child('main')
    log.error('crash', new Error('e'))
    log.debug('ignored')
    expect(up.pending()).toBe(1)
  })
})

describe('computeDeviceId', () => {
  test('相同硬件特征恒定，任一特征变化即不同', () => {
    const a = computeDeviceId(['host', 'darwin', 'arm64', 'M3', '17179869184', 'aa:bb'])
    const b = computeDeviceId(['host', 'darwin', 'arm64', 'M3', '17179869184', 'aa:bb'])
    const c = computeDeviceId(['host2', 'darwin', 'arm64', 'M3', '17179869184', 'aa:bb'])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[a-f0-9]{32}$/)
  })
})
