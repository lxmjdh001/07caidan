import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: class {}
}))

const { buildCrispHtml } = await import('./crisp')

describe('buildCrispHtml', () => {
  const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  test('嵌入 Website ID、官方脚本与会话数据', () => {
    const html = buildCrispHtml(ID, {
      email: 'boss@test.com',
      data: [
        ['plan', 'Pro 月付'],
        ['app_version', '1.2.3'],
        ['device_id', 'abc123']
      ]
    })
    expect(html).toContain(`window.CRISP_WEBSITE_ID=${JSON.stringify(ID)}`)
    expect(html).toContain('client.crisp.chat/l.js')
    expect(html).toContain('"user:email"')
    expect(html).toContain('boss@test.com')
    expect(html).toContain('"session:data"')
    expect(html).toContain('Pro 月付')
    expect(html).toContain('device_id')
  })

  test('无邮箱（游客）时不推 user:email', () => {
    const html = buildCrispHtml(ID, { data: [['app_version', '1.0.0']] })
    expect(html).not.toContain('user:email')
  })

  test('非法 Website ID 拒绝生成（防注入）', () => {
    expect(() => buildCrispHtml('"></script><script>alert(1)</script>', { data: [] })).toThrow()
  })

  test('会话数据值经 JSON 序列化，特殊字符不破坏脚本', () => {
    const html = buildCrispHtml(ID, { data: [['note', '"</script>']] })
    expect(html).toContain(JSON.stringify([['note', '"</script>']]).slice(1, -1))
  })
})
