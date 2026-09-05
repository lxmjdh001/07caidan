import { describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '@shared/settings'
import { fingerprintFromSeed } from './account-fingerprint'
import {
  AccountNetworkIsolation,
  PROXY_PROBE_TARGETS,
  probeThroughProxy,
  type ProxyTargetRequest
} from './network-isolation'

function fixture(config: AccountConfig, probe = vi.fn(async () => ({ exitIp: '203.0.113.8', latencyMs: 42 }))) {
  const states: unknown[] = []
  const isolation = new AccountNetworkIsolation({
    getAccountConfig: () => config,
    getBackend: () => ({ url: 'https://wzzapp.cloud', token: 'token' }),
    onState: (state) => states.push(state),
    probe
  })
  return { isolation, probe, states }
}

describe('AccountNetworkIsolation', () => {
  it('无代理时 fail-closed，绝不执行网络探测', async () => {
    const f = fixture({ fingerprint: fingerprintFromSeed('line:a1', 'seed', 1) })
    await expect(f.isolation.assertReady('line:a1')).rejects.toThrow('不会回落')
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.isolation.state('line:a1').status).toBe('blocked')
  })

  it('无设备指纹时禁止登录', async () => {
    const f = fixture({ proxyUrl: 'socks5://127.0.0.1:1080' })
    await expect(f.isolation.assertReady('line:a1')).rejects.toThrow('指纹未生成')
    expect(f.probe).not.toHaveBeenCalled()
  })

  it('启动门禁只校验代理配置，不执行外部检测', async () => {
    const config = {
      proxyUrl: ' socks5://u:p@127.0.0.1:1080 ',
      fingerprint: fingerprintFromSeed('line:a1', 'seed', 1)
    }
    const f = fixture(config)
    await f.isolation.assertReady('line:a1')
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.isolation.state('line:a1')).toMatchObject({
      status: 'ready',
      detail: '代理已配置，连接结果由平台返回'
    })
  })

  it('候选代理测试只返回结果，不保存也不改变当前网络状态', async () => {
    const config = {
      proxyUrl: 'socks5://127.0.0.1:1080',
      fingerprint: fingerprintFromSeed('line:a1', 'seed', 1)
    }
    const f = fixture(config)
    const before = f.isolation.state('line:a1')
    const result = await f.isolation.test('line:a1', ' socks5://user:pass@198.51.100.9:2080 ')

    expect(f.probe).toHaveBeenCalledWith(
      'https://wzzapp.cloud',
      'token',
      'socks5://user:pass@198.51.100.9:2080'
    )
    expect(result).toMatchObject({
      accountKey: 'line:a1',
      proxyUrl: 'socks5://user:pass@198.51.100.9:2080',
      exitIp: '203.0.113.8',
      latencyMs: 42
    })
    expect(config.proxyUrl).toBe('socks5://127.0.0.1:1080')
    expect(f.isolation.state('line:a1')).toEqual(before)
    expect(f.states).toEqual([])
  })

  it('代理库检测无需先选择账号或生成账号指纹', async () => {
    const f = fixture({})
    const result = await f.isolation.testProxy(' 198.51.100.9:2080 ')
    expect(f.probe).toHaveBeenCalledWith(
      'https://wzzapp.cloud',
      'token',
      'socks5://198.51.100.9:2080'
    )
    expect(result).toMatchObject({
      proxyUrl: 'socks5://198.51.100.9:2080',
      exitIp: '203.0.113.8',
      latencyMs: 42
    })
    expect(f.states).toEqual([])
  })

  it('连通性目标成功但没有出口 IP 时也判定代理可用', async () => {
    const probe = vi.fn(async () => ({ latencyMs: 18 }))
    const f = fixture({}, probe)
    const result = await f.isolation.testProxy('socks5://198.51.100.9:2080')

    expect(result).toMatchObject({
      proxyUrl: 'socks5://198.51.100.9:2080',
      latencyMs: 18
    })
    expect(result).not.toHaveProperty('exitIp')
  })

  it('候选代理测试失败不阻断正在使用的旧代理状态', async () => {
    const probe = vi.fn(async () => { throw new Error('ETIMEDOUT') })
    const f = fixture({
      proxyUrl: 'socks5://127.0.0.1:1080',
      fingerprint: fingerprintFromSeed('line:a1', 'seed', 1)
    }, probe)

    await f.isolation.assertReady('line:a1')
    await expect(f.isolation.test('line:a1', 'socks5://198.51.100.9:2080')).rejects.toThrow('ETIMEDOUT')
    expect(f.isolation.state('line:a1')).toMatchObject({ status: 'ready' })
  })

  it('代理失败时明确报告隔离，且不执行第二条直连路径', async () => {
    const probe = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const f = fixture({
      proxyUrl: 'http://127.0.0.1:8080',
      fingerprint: fingerprintFromSeed('whatsapp:a1', 'seed', 1)
    }, probe)
    await expect(f.isolation.check('whatsapp:a1')).rejects.toThrow('阻止直连')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(f.isolation.state('whatsapp:a1').status).toBe('blocked')
  })

  it('Telegram HTTP 代理在探测前即被拒绝', async () => {
    const f = fixture({
      proxyUrl: 'http://127.0.0.1:8080',
      fingerprint: fingerprintFromSeed('telegram:a1', 'seed', 1)
    })
    await expect(f.isolation.assertReady('telegram:a1')).rejects.toThrow('仅支持 SOCKS')
    expect(f.probe).not.toHaveBeenCalled()
  })
})

describe('probeThroughProxy', () => {
  it('包含产品指定的全部连通性目标', () => {
    expect(PROXY_PROBE_TARGETS.map((target) => target.url)).toEqual([
      'https://ip-api.com/',
      'https://ipinfo.io/',
      'https://worldip.io/',
      'https://iplark.com/',
      'https://www.line.me/en/',
      'https://web.whatsapp.com/',
      'http://api.ipify.org/?format=json'
    ])
  })

  it('并发访问全部目标，任意一个响应就立即成功并取消其余请求', async () => {
    const started: string[] = []
    const cancelled: string[] = []
    const requestTarget: ProxyTargetRequest = vi.fn(async (_proxyUrl, target, signal) => {
      started.push(target.name)
      if (target.name === 'LINE') return { latencyMs: 16 }
      return new Promise<{ latencyMs: number }>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          cancelled.push(target.name)
          reject(new Error('检测取消'))
        }, { once: true })
      })
    })

    await expect(probeThroughProxy('', '', 'socks5://198.51.100.9:2080', requestTarget))
      .resolves.toEqual({ latencyMs: 16 })
    expect(started).toHaveLength(PROXY_PROBE_TARGETS.length)
    expect(cancelled).toHaveLength(PROXY_PROBE_TARGETS.length - 1)
  })

  it('全部目标失败时只返回网络错误', async () => {
    const requestTarget: ProxyTargetRequest = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })

    await expect(probeThroughProxy('', '', 'socks5://198.51.100.9:2080', requestTarget))
      .rejects.toThrow('网络错误')
  })
})
