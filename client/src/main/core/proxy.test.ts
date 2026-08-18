import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { Agent as UndiciAgent, ProxyAgent } from 'undici'
import { describe, expect, it } from 'vitest'
import { createDispatcher, createProxyAgent, withDispatcher } from './proxy'

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
