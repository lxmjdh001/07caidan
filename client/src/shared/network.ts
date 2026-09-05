/** 账号网络隔离状态（主进程检测，渲染进程只负责展示）。 */
export type AccountNetworkStatus = 'unconfigured' | 'checking' | 'ready' | 'blocked'

export interface AccountNetworkState {
  accountKey: string
  status: AccountNetworkStatus
  exitIp?: string
  latencyMs?: number
  checkedAt?: number
  detail?: string
}

export interface ProxyProbe {
  proxyUrl: string
  /** 兼容历史出口记录；当前检测只验证代理连通性，不查询出口 IP。 */
  exitIp?: string
  latencyMs: number
  checkedAt: number
  proxyHash: string
}

export interface AccountNetworkProbe extends ProxyProbe {
  accountKey: string
}

/** 账号弹窗的快速检测结果；平台直连检测不一定提供出口 IP。 */
export interface AccountProxyTestResult {
  accountKey: string
  proxyUrl: string
  target: string
  exitIp?: string
  latencyMs: number
  checkedAt: number
}

export interface ConfigureAccountNetworkInput {
  /** 直接填写的代理（兼容旧入口）；选择代理库资产时可省略。 */
  proxyUrl?: string
  /** 从独立代理库关联到账号。 */
  proxyId?: string
  /** 代理资产备注；未传表示保留原值，空串表示清空。 */
  note?: string
  /** 保存并通过安全门禁启动登录/重连。 */
  connect?: boolean
  /** 跳过候选代理探测，保存后直接由平台连接判断是否可用。 */
  skipTest?: boolean
}

export interface ConfigureAccountNetworkResult {
  /** 未跳过检测时返回；直接保存时为空。 */
  probe?: AccountNetworkProbe
  settings: import('./settings').AppSettings
  /** 已保存但平台未能连接时返回给界面的简洁错误。 */
  connectionError?: string
}

export interface SaveProxyAssetInput {
  /** 缺省为新增；传入则编辑现有资产。 */
  id?: string
  proxyUrl: string
  note?: string
  /** 仅由显式“检测”操作开启；普通保存不等待网络检测。 */
  verify?: boolean
}

export interface SaveProxyAssetResult {
  asset: import('./settings').ProxyAsset
  probe?: ProxyProbe
  settings: import('./settings').AppSettings
}
