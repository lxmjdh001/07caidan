export interface TelegramAuthRecovery {
  retry: boolean
  step?: 'phone' | 'code' | 'password'
  detail?: string
}

/** 把 Telegram 的认证 RPC 错误转换成可继续交互的步骤，不因一次输错终止整个登录。 */
export function telegramAuthRecovery(error: Error): TelegramAuthRecovery {
  const rpc = error as Error & { errorMessage?: string }
  const code = rpc.errorMessage || error.message

  if (code.includes('PASSWORD_HASH_INVALID')) {
    return {
      retry: true,
      step: 'password',
      detail: '输入未通过 Telegram 验证，请重新输入两步验证密码；也可切换到手机号登录使用应用内验证码。'
    }
  }
  if (code.includes('PHONE_CODE_INVALID') || code.includes('PHONE_CODE_EMPTY')) {
    return { retry: true, step: 'code', detail: '应用内验证码不正确，请重新输入。' }
  }
  if (code.includes('PHONE_NUMBER_INVALID')) {
    return { retry: true, step: 'phone', detail: '手机号格式不正确，请包含国家码后重新输入。' }
  }
  if (code.includes('PHONE_CODE_EXPIRED')) {
    return { retry: false, detail: '应用内验证码已过期，请重新发起手机号登录。' }
  }
  return { retry: false }
}
