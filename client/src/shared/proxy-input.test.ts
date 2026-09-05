import { describe, expect, it } from 'vitest'
import { composeProxyUrl, splitProxyInput } from './proxy-input'

describe('代理输入框协议与常见供应商格式', () => {
  it('无协议时默认 SOCKS5', () => {
    expect(splitProxyInput('104.253.219.116:6525')).toEqual({
      protocol: 'socks5',
      address: '104.253.219.116:6525'
    })
    expect(composeProxyUrl('socks5', '104.253.219.116:6525')).toBe(
      'socks5://104.253.219.116:6525'
    )
  })

  it('IP:端口:账号:密码自动转换成标准认证 URL', () => {
    expect(composeProxyUrl('socks5', '104.253.219.116:6525:mrwkbezq:dqigh7rc61dg')).toBe(
      'socks5://mrwkbezq:dqigh7rc61dg@104.253.219.116:6525'
    )
  })

  it('四段格式中的特殊密码会正确编码', () => {
    expect(composeProxyUrl('http', 'proxy.test:8080:user:p@ss:word')).toBe(
      'http://user:p%40ss%3Aword@proxy.test:8080'
    )
  })

  it('粘贴完整 URL 时识别其协议，不重复添加前缀', () => {
    expect(splitProxyInput('https://user:pass@proxy.test:443')).toEqual({
      protocol: 'https',
      address: 'user:pass@proxy.test:443'
    })
    expect(composeProxyUrl('socks5', 'http://proxy.test:8080')).toBe(
      'http://proxy.test:8080'
    )
  })
})
