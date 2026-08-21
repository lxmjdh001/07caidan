import { describe, expect, it, vi } from 'vitest'
import { LinePollCoordinator } from './poll-coordinator'

function coordinator(
  events: Record<string, unknown[]>,
  calls: string[] = [],
  be: () => { url?: string; token?: string } = backend
): LinePollCoordinator {
  return new LinePollCoordinator(be, undefined, fakeFetch(events, calls))
}

function fakeFetch(events: Record<string, unknown[]>, calls: string[] = []): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => ({ events })
    }
  }) as unknown as typeof fetch
}

const backend = () => ({ url: 'https://b', token: 't' })

describe('LinePollCoordinator', () => {
  it('一次拉取分发到多个账号 —— 请求量与账号数解耦', async () => {
    const got: Record<string, unknown[]> = {}
    const calls: string[] = []
    const c = coordinator({ a1: [{ n: 1 }], a2: [{ n: 2 }, { n: 3 }] }, calls)
    c.register('a1', (e) => {
      got.a1 = e
    })
    c.register('a2', (e) => {
      got.a2 = e
    })
    await c.poll()
    expect(got.a1).toEqual([{ n: 1 }])
    expect(got.a2).toHaveLength(2)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/api/line/pull-all')
    c.unregister('a1')
    c.unregister('a2')
  })

  it('未注册账号的事件被丢弃，不抛错', async () => {
    const c = coordinator({ ghost: [{ n: 1 }] })
    c.register('a1', () => {})
    await c.poll()
    c.unregister('a1')
  })

  it('单个账号的处理异常不影响其它账号', async () => {
    const got: unknown[] = []
    const c = coordinator({ bad: [{ n: 1 }], good: [{ n: 2 }] })
    c.register('bad', () => {
      throw new Error('boom')
    })
    c.register('good', (e) => {
      got.push(...e)
    })
    await c.poll()
    expect(got).toEqual([{ n: 2 }])
    c.unregister('bad')
    c.unregister('good')
  })

  it('没有注册账号时不发请求', async () => {
    const calls: string[] = []
    const c = coordinator({}, calls)
    await c.poll()
    expect(calls).toHaveLength(0)
  })

  it('后台未配置时静默跳过', async () => {
    const calls: string[] = []
    const c = coordinator({}, calls, () => ({}))
    c.register('a1', () => {})
    await c.poll()
    expect(calls).toHaveLength(0)
    c.unregister('a1')
  })

  it('网络失败不抛出，下轮重试', async () => {
    const c = new LinePollCoordinator(backend, undefined, (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch)
    c.register('a1', () => {})
    await c.poll()
    c.unregister('a1')
  })

  it('注销全部账号后 size 归零（定时器随之停止）', () => {
    const c = new LinePollCoordinator(backend)
    c.register('a1', () => {})
    c.register('a2', () => {})
    expect(c.size()).toBe(2)
    c.unregister('a1')
    c.unregister('a2')
    expect(c.size()).toBe(0)
  })

  it('轮询进行中并发再拉直接跳过 —— polling 锁防重叠(慢网络下不重复拉/不打爆后台)', async () => {
    // 上一条 size 用例只看计数，没验「定时器真停」；这条与下一条把两个易漏的行为补上。
    // polling 锁：第一次 poll 还在等 fetch 时，第二次 poll 必须直接返回，否则慢网络下会
    // 叠出多个并发请求、同批事件被重复分发。锁在首个 await 前同步置位，故第二次同步进来即被挡。
    let fetchCount = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const c = new LinePollCoordinator(backend, undefined, (async () => {
      fetchCount++
      await gate // 卡住第一次拉取，制造并发窗口
      return { ok: true, status: 200, json: async () => ({ events: {} }) }
    }) as unknown as typeof fetch)
    c.register('a1', () => {})
    const p1 = c.poll() // 进入，polling=true，停在 gate
    const p2 = c.poll() // polling 已 true → 直接返回，不发第二次请求
    release()
    await Promise.all([p1, p2])
    expect(fetchCount).toBe(1) // 第二次被 polling 锁挡下
    c.unregister('a1')
  })

  it('定时器生命周期：首个注册启一个、后续不重复起（单例）、末个注销才清（不泄漏）', () => {
    // size 归零 ≠ 定时器已清 —— poll() 对空 handlers 会自我早退，所以「没拉取」根本证明不了
    // 定时器停了(这条曾用 fetchCount 写法验不出泄漏)。直接监视 setInterval/clearInterval 的调用
    // 才是真信号：整机单例(两次注册只起一个)、还有账号在不清、末个注销清且仅清一次。
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    try {
      const c = new LinePollCoordinator(backend, undefined, (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ events: {} })
      })) as unknown as typeof fetch)
      c.register('a1', () => {})
      expect(setSpy).toHaveBeenCalledTimes(1) // 首个注册启动定时器
      c.register('a2', () => {})
      expect(setSpy).toHaveBeenCalledTimes(1) // 第二个不再起新定时器（整机单例）
      c.unregister('a1')
      expect(clearSpy).not.toHaveBeenCalled() // 还有 a2 在，不清
      c.unregister('a2')
      expect(clearSpy).toHaveBeenCalledTimes(1) // 末个注销 → 清理定时器且仅一次
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })
})
