import { describe, expect, it } from 'vitest'
import { shouldShowLoginPanel } from './login-flow'

describe('shouldShowLoginPanel', () => {
  it.each(['waiting_phone', 'waiting_code', 'waiting_password'] as const)(
    'Telegram 登录推进到 %s 后仍保留主登录面板',
    (status) => {
      expect(shouldShowLoginPanel(status)).toBe(true)
    }
  )

  it('最终授权成功后才退出登录面板', () => {
    expect(shouldShowLoginPanel('connecting')).toBe(true)
    expect(shouldShowLoginPanel('connected')).toBe(false)
  })
})
