import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { Agent as UndiciAgent, ProxyAgent } from 'undici'
import { describe, expect, it } from 'vitest'
import {
  createDispatcher,
  createProxyAgent,
  createRequiredDispatcher,
  createRequiredProxyAgent,
  createRequiredSocksProxyConfig,
  createSocksProxyConfig,
  normalizeProxyForAccount,
  normalizeProxyUrl,
  proxyHash,
  redactProxyUrl,
  withDispatcher
} from './proxy'

describe('createProxyAgent', () => {
  it('空值/空串/空白 → 不使用代理', () => {
    expect(createProxyAgent(undefined)).toBeUndefined()
    expect(createProxyAgent('')).toBeUndefined()
    expect(createProxyAgent('   ')).toBeUndefined()
  })

  it('socks5/socks4/socks → SocksProxyAgent（含账号密码）', () => {
    expect(createProxyAgent('socks5://127.0.0.1:1080')).toBeInstanceOf(SocksProxyAgent)
    expect(createProxyAgent('socks4://127.0.0.1:1080')).toBeInstanceOf(SocksProxyAgent)
    expect(createProxyAgent('socks5://user:pass@10.0.0.1:7890')).toBeInstanceOf(SocksProxyAgent)
  })

  it('SOCKS 目标域名始终交给代理端解析，避免本机 DNS 泄漏', () => {
    expect((createProxyAgent('socks5://127.0.0.1:1080') as SocksProxyAgent).shouldLookup).toBe(false)
    expect((createProxyAgent('socks4://127.0.0.1:1080') as SocksProxyAgent).shouldLookup).toBe(false)
  })

  it('http/https → HttpsProxyAgent', () => {
    expect(createProxyAgent('http://127.0.0.1:8888')).toBeInstanceOf(HttpsProxyAgent)
    expect(createProxyAgent('https://proxy.example.com:443')).toBeInstanceOf(HttpsProxyAgent)
  })

  it('非法格式与不支持的协议抛出可读错误', () => {
    expect(() => createProxyAgent('not a url')).toThrow('格式非法')
    expect(() => createProxyAgent('ftp://127.0.0.1:21')).toThrow('不支持的代理协议')
  })
})

describe('createDispatcher（供 Telegram/LINE 的 fetch 使用）', () => {
  it('空值 → 不走代理', () => {
    expect(createDispatcher(undefined)).toBeUndefined()
    expect(createDispatcher('')).toBeUndefined()
    expect(createDispatcher('   ')).toBeUndefined()
  })

  it('http/https → undici ProxyAgent', () => {
    expect(createDispatcher('http://127.0.0.1:8888')).toBeInstanceOf(ProxyAgent)
    expect(createDispatcher('https://proxy.example.com:443')).toBeInstanceOf(ProxyAgent)
  })

  it('socks4/5 → undici Agent（自建 socks 连接）', () => {
    expect(createDispatcher('socks5://127.0.0.1:1080')).toBeInstanceOf(UndiciAgent)
    expect(createDispatcher('socks4://127.0.0.1:1080')).toBeInstanceOf(UndiciAgent)
    expect(createDispatcher('socks5://user:pass@10.0.0.1:7890')).toBeInstanceOf(UndiciAgent)
  })

  it('非法/不支持的协议抛可读错误；socks 缺端口报错', () => {
    expect(() => createDispatcher('not a url')).toThrow('格式非法')
    expect(() => createDispatcher('ftp://127.0.0.1:21')).toThrow('不支持的代理协议')
    expect(() => createDispatcher('socks5://127.0.0.1')).toThrow('主机或端口')
  })
})

describe('withDispatcher', () => {
  it('无 dispatcher → 原样返回 init', () => {
    const init = { method: 'POST' as const }
    expect(withDispatcher(init, undefined)).toBe(init)
  })

  it('有 dispatcher → 注入 dispatcher 字段', () => {
    const d = createDispatcher('http://127.0.0.1:8888')
    const out = withDispatcher({ method: 'POST' }, d) as { dispatcher?: unknown; method?: string }
    expect(out.dispatcher).toBe(d)
    expect(out.method).toBe('POST')
  })
})

// createSocksProxyConfig：Telegram(GramJS/MTProto) 专用的 SOCKS 配置解析，与 http Agent 是两条路。
// GramJS 只吃 SOCKS4/5，http 代理必须回 undefined(否则连接层会拿到错误配置)。此前零覆盖。
describe('createSocksProxyConfig（Telegram MTProto SOCKS）', () => {
  it('空值/空白 → undefined', () => {
    expect(createSocksProxyConfig(undefined)).toBeUndefined()
    expect(createSocksProxyConfig('   ')).toBeUndefined()
  })

  it('socks5 → type 5、socks4 → type 4、socks 默认 5', () => {
    expect(createSocksProxyConfig('socks5://1.2.3.4:1080')).toMatchObject({
      ip: '1.2.3.4',
      port: 1080,
      socksType: 5
    })
    expect(createSocksProxyConfig('socks4://1.2.3.4:1080')?.socksType).toBe(4)
    expect(createSocksProxyConfig('socks://1.2.3.4:1080')?.socksType).toBe(5)
  })

  it('提取账号密码与端口', () => {
    expect(createSocksProxyConfig('socks5://u:p%40ss@10.0.0.1:7890')).toMatchObject({
      ip: '10.0.0.1',
      port: 7890,
      username: 'u',
      password: 'p@ss'
    })
  })

  it('http/https → undefined（GramJS MTProto 不支持 http 代理）', () => {
    expect(createSocksProxyConfig('http://1.2.3.4:8888')).toBeUndefined()
    expect(createSocksProxyConfig('https://1.2.3.4:443')).toBeUndefined()
  })

  it('非法 URL 抛错；socks 缺端口抛错', () => {
    expect(() => createSocksProxyConfig('not a url')).toThrow('格式非法')
    expect(() => createSocksProxyConfig('socks5://1.2.3.4')).toThrow('缺少主机或端口')
  })
})

describe('严格账号代理策略', () => {
  it('规范化代理并保留认证信息', () => {
    expect(normalizeProxyUrl(' socks5://user:p%40ss@127.0.0.1:1080 ')).toBe(
      'socks5://user:p%40ss@127.0.0.1:1080'
    )
    expect(normalizeProxyUrl('https://proxy.example.com:443')).toBe(
      'https://proxy.example.com:443'
    )
    expect(normalizeProxyUrl('104.253.219.116:6525')).toBe(
      'socks5://104.253.219.116:6525'
    )
    expect(normalizeProxyUrl('104.253.219.116:6525:mrwkbezq:dqigh7rc61dg')).toBe(
      'socks5://mrwkbezq:dqigh7rc61dg@104.253.219.116:6525'
    )
  })

  it('空值、路径和不支持协议一律拒绝', () => {
    expect(() => normalizeProxyUrl('')).toThrow('不会回落')
    expect(() => normalizeProxyUrl('ftp://127.0.0.1:21')).toThrow('不支持')
    expect(() => normalizeProxyUrl('http://127.0.0.1:8080/path')).toThrow('不能包含路径')
  })

  it('Telegram 普通账号只允许 SOCKS，避免 HTTP 配置被 GramJS 忽略后直连', () => {
    expect(() => normalizeProxyForAccount('telegram:a1', 'http://127.0.0.1:8080')).toThrow('仅支持')
    expect(normalizeProxyForAccount('telegram:a1', 'socks5://127.0.0.1:1080')).toBe(
      'socks5://127.0.0.1:1080'
    )
    expect(normalizeProxyForAccount('telegram_bot:a1', 'http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080'
    )
  })

  it('required 工厂缺代理时 fail-closed', () => {
    expect(() => createRequiredProxyAgent(undefined)).toThrow('阻止直连')
    expect(() => createRequiredDispatcher('')).toThrow('阻止直连')
    expect(() => createRequiredSocksProxyConfig('http://127.0.0.1:8080')).toThrow('仅支持')
  })

  it('摘要稳定且日志脱敏', () => {
    expect(proxyHash('http://user:pass@127.0.0.1:8080')).toBe(
      proxyHash(' http://user:pass@127.0.0.1:8080 ')
    )
    expect(redactProxyUrl('http://user:pass@127.0.0.1:8080')).toBe('http://***@127.0.0.1:8080')
  })
})
