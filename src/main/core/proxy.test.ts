import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { describe, expect, it } from 'vitest'
import { createProxyAgent } from './proxy'

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
