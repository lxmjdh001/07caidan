import { describe, expect, it } from 'vitest'
import { telegramAuthRecovery } from './auth-error'

function rpcError(code: string): Error {
  return Object.assign(new Error(code), { errorMessage: code })
}

describe('telegramAuthRecovery', () => {
  it('应用内验证码输错后留在验证码步骤重试', () => {
    expect(telegramAuthRecovery(rpcError('PHONE_CODE_INVALID'))).toMatchObject({
      retry: true,
      step: 'code'
    })
  })

  it('两步密码输错后留在密码步骤重试', () => {
    expect(telegramAuthRecovery(rpcError('PASSWORD_HASH_INVALID'))).toMatchObject({
      retry: true,
      step: 'password'
    })
  })

  it('验证码过期后停止当前流程，避免继续提交旧 code hash', () => {
    expect(telegramAuthRecovery(rpcError('PHONE_CODE_EXPIRED'))).toMatchObject({ retry: false })
  })
})
