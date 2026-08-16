import { describe, expect, it } from 'vitest'
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
})
