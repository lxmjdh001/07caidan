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

  test('会话数据里的 </script> 被转义，无法突破内联脚本注入', () => {
    // 管理员可配的套餐名等会进 session.data。若原样嵌入内联 <script>，值里的 </script>
    // 会被 HTML 解析器当成脚本结束标签 → 其后的 <script> 就地执行。必须转义 < 杜绝突破。
    const html = buildCrispHtml(ID, {
      data: [['plan', '</script><script>window.__PWN=1</script>']]
    })
    // 突破序列绝不能原样出现（原样出现即：HTML 解析器就地结束脚本、其后标签执行 = 注入）
    expect(html).not.toContain('</script><script>')
    // < 应以 \u003c 转义形式落地（仍是合法 JSON，Crisp 运行时读到的值语义不变）
    expect(html).toContain('\\u003c/script>\\u003cscript>')
  })

  test('邮箱里的 </script> 同样被转义（user:email 也是内联注入面）', () => {
    const html = buildCrispHtml(ID, {
      email: 'a</script><script>alert(1)</script>@x.com',
      data: []
    })
    expect(html).not.toContain('</script><script>')
    expect(html).toContain('\\u003c/script>')
  })
})
