/** 去掉末尾斜杠，避免同一个后台地址被当成两个环境。 */
export function cleanBackendUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function isLoopback(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

/**
 * 正式安装包覆盖开发测试包时，settings.json 会保留旧的 localhost 地址。
 * 登录页虽然使用品牌后台，但已登录状态下所有同步/工单请求仍会继续打 localhost。
 *
 * 只迁移「打包应用 + 旧地址明确是回环地址 + 品牌地址是公网」这一种无歧义情况；
 * 自定义的远程测试后台不会被擅自覆盖。
 */
export function packagedBackendMigration(
  current: string,
  branded: string,
  packaged: boolean
): string | undefined {
  const from = cleanBackendUrl(current)
  const to = cleanBackendUrl(branded)
  if (!packaged || !from || !to || from === to) return undefined
  return isLoopback(from) && !isLoopback(to) ? to : undefined
}
