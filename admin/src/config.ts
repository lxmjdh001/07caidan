/**
 * 后台地址来自构建配置，不在登录界面输入。
 * 设置方式：admin/.env 里 `VITE_API_BASE=https://api.example.com`
 * 未设置时：同源（生产用反代）或本地开发默认 8787。
 */
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ||
  (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)
