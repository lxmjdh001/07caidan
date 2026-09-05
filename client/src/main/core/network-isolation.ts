import { isIP } from 'node:net'
import { get as httpGet, type ClientRequest, type IncomingMessage } from 'node:http'
import { get as httpsGet } from 'node:https'
import { SocksClient } from 'socks'
import type { AccountNetworkProbe, AccountNetworkState, AccountProxyTestResult, ProxyProbe } from '@shared/network'
import type { AccountConfig } from '@shared/settings'
import type { Logger } from './logger'
import { noopLogger } from './logger'
import {
  createRequiredProxyAgent,
  createRequiredSocksProxyConfig,
  normalizeProxyForAccount,
  normalizeProxyUrl,
  proxyHash,
  redactProxyUrl
} from './proxy'
import { validFingerprint } from './account-fingerprint'

export interface NetworkIsolationOptions {
  getAccountConfig: (key: string) => AccountConfig | undefined
  getBackend: () => { url?: string; token?: string }
  onState: (state: AccountNetworkState) => void
  logger?: Logger
  /** 测试注入点；生产默认实现始终使用传入代理 dispatcher。 */
  probe?: (backendUrl: string, token: string, proxyUrl: string) => Promise<{ exitIp?: string; latencyMs: number }>
}

export interface ProxyProbeTarget {
  name: string
  url: string
}

/**
 * 代理检测的容错目标。这里只判断目标是否经代理返回了 HTTP 响应，
 * 不读取正文、不查询或推断出口 IP。
 */
export const PROXY_PROBE_TARGETS: readonly ProxyProbeTarget[] = [
  { name: 'ip-api.com', url: 'https://ip-api.com/' },
  { name: 'ipinfo.io', url: 'https://ipinfo.io/' },
  { name: 'worldip.io', url: 'https://worldip.io/' },
  { name: 'iplark.com', url: 'https://iplark.com/' },
  { name: 'LINE', url: 'https://www.line.me/en/' },
  { name: 'WhatsApp Web', url: 'https://web.whatsapp.com/' },
  { name: 'api.ipify.org', url: 'http://api.ipify.org/?format=json' }
]

export type ProxyTargetRequest = (
  proxyUrl: string,
  target: ProxyProbeTarget,
  signal: AbortSignal
) => Promise<{ latencyMs: number }>

/**
 * 所有平台账号共用的强制网络门禁。
 *
 * - 无代理/无指纹：不调用适配器，不产生任何平台连接。
 * - 保存/启动不做外部探测，直接由平台连接判断代理是否可用。
 * - 平台适配器始终只使用配置的代理；失败不会回退本机直连。
 * - “检测”按钮显式触发多目标连通性检测，不改变当前平台连接。
 */
export class AccountNetworkIsolation {
  private readonly states = new Map<string, AccountNetworkState>()
  private readonly log: Logger
  private readonly probe: NonNullable<NetworkIsolationOptions['probe']>

  constructor(private readonly options: NetworkIsolationOptions) {
    this.log = (options.logger ?? noopLogger).child('network-isolation')
    this.probe = options.probe ?? probeThroughProxy
  }

  list(accountKeys: string[]): AccountNetworkState[] {
    return accountKeys.map((key) => this.states.get(key) ?? this.stateFromConfig(key))
  }

  state(accountKey: string): AccountNetworkState {
    return this.states.get(accountKey) ?? this.stateFromConfig(accountKey)
  }

  /** 已通过本次运行的门禁且未被监控判定断线时，平台流量才可继续。 */
  isUsable(accountKey: string): boolean {
    const status = this.state(accountKey).status
    return status === 'ready' || status === 'checking'
  }

  /**
   * 检测客户刚填写的候选代理，不写设置、不发布网络状态，也不会触碰当前平台连接。
   * 这样已在线账号可以安全测试新代理，确认出口后再决定是否切换。
   */
  async test(accountKey: string, candidateProxyUrl: string): Promise<AccountNetworkProbe> {
    const config = this.options.getAccountConfig(accountKey)
    if (!config) throw new Error(`账号不存在：${accountKey}`)
    if (!validFingerprint(config.fingerprint)) {
      throw new Error('设备指纹未生成，无法检测账号代理')
    }

    const proxyUrl = normalizeProxyForAccount(accountKey, candidateProxyUrl)
    const probe = await this.probeCandidate(proxyUrl, accountKey)
    return { accountKey, ...probe }
  }

  /** 账号弹窗使用的快速检测：Telegram 直接验证 SOCKS5 → Telegram DC。 */
  async testConnection(accountKey: string, candidateProxyUrl: string): Promise<AccountProxyTestResult> {
    const config = this.options.getAccountConfig(accountKey)
    if (!config) throw new Error(`账号不存在：${accountKey}`)
    if (!validFingerprint(config.fingerprint)) {
      throw new Error('设备指纹未生成，无法检测账号代理')
    }

    const proxyUrl = normalizeProxyForAccount(accountKey, candidateProxyUrl)
    if (accountKey.startsWith('telegram:')) {
      try {
        const latencyMs = await probeTelegramThroughSocks(proxyUrl)
        const result: AccountProxyTestResult = {
          accountKey,
          proxyUrl,
          target: 'Telegram',
          latencyMs,
          checkedAt: Date.now()
        }
        this.log.info('Telegram 代理快速检测通过', {
          accountKey,
          proxy: redactProxyUrl(proxyUrl),
          latencyMs
        })
        return result
      } catch (error) {
        this.log.warn('Telegram 代理快速检测失败', {
          accountKey,
          proxy: redactProxyUrl(proxyUrl),
          error: messageOf(error)
        })
        throw new Error(`代理不可用，安全隔离已阻止直连：${messageOf(error)}`)
      }
    }

    const probe = await this.probeCandidate(proxyUrl, accountKey)
    return {
      accountKey,
      proxyUrl: probe.proxyUrl,
      target: '公网出口',
      exitIp: probe.exitIp,
      latencyMs: probe.latencyMs,
      checkedAt: probe.checkedAt
    }
  }

  /** 检测代理库里的独立资产，不要求先选择账号，也不改变任何账号网络状态。 */
  async testProxy(candidateProxyUrl: string): Promise<ProxyProbe> {
    return this.probeCandidate(normalizeProxyUrl(candidateProxyUrl))
  }

  /** 保存/关联完成后，把同一次可信检测结果应用到账号的运行时门禁状态。 */
  markReady(accountKey: string, probe: ProxyProbe): void {
    this.publish({
      accountKey,
      status: 'ready',
      exitIp: probe.exitIp,
      latencyMs: probe.latencyMs,
      checkedAt: probe.checkedAt
    })
  }

  /** 解除代理关联后立即清除旧的 ready 状态。 */
  reset(accountKey: string): void {
    this.states.delete(accountKey)
    this.publish(this.stateFromConfig(accountKey))
  }

  private async probeCandidate(proxyUrl: string, accountKey?: string): Promise<ProxyProbe> {

    const backend = this.options.getBackend()
    if (!backend.url || !backend.token) {
      throw new Error('请先登录 WzzScrm 后台，再检测代理出口')
    }

    try {
      const result = await this.probe(backend.url, backend.token, proxyUrl)
      const checkedAt = Date.now()
      const exitIp = result.exitIp ? normalizeExitIp(result.exitIp) : undefined
      const probe: ProxyProbe = {
        proxyUrl,
        ...(exitIp ? { exitIp } : {}),
        latencyMs: Math.max(0, Math.round(result.latencyMs)),
        checkedAt,
        proxyHash: proxyHash(proxyUrl)
      }
      this.log.info('候选代理检测通过', {
        ...(accountKey ? { accountKey } : {}),
        proxy: redactProxyUrl(proxyUrl),
        exitIp: probe.exitIp,
        latencyMs: probe.latencyMs
      })
      return probe
    } catch (error) {
      this.log.warn('候选代理检测失败', {
        ...(accountKey ? { accountKey } : {}),
        proxy: redactProxyUrl(proxyUrl),
        error: messageOf(error)
      })
      throw new Error(`代理不可用，安全隔离已阻止直连：${messageOf(error)}`)
    }
  }

  async check(accountKey: string, candidateProxyUrl?: string): Promise<AccountNetworkProbe> {
    const config = this.options.getAccountConfig(accountKey)
    const proxyUrl = candidateProxyUrl ?? config?.proxyUrl ?? ''
    this.publish({ accountKey, status: 'checking', detail: '正在通过独立代理检测出口…' })
    try {
      const probe = await this.test(accountKey, proxyUrl)
      this.publish({
        accountKey,
        status: 'ready',
        exitIp: probe.exitIp,
        latencyMs: probe.latencyMs,
        checkedAt: probe.checkedAt
      })
      return probe
    } catch (error) {
      return this.fail(accountKey, messageOf(error))
    }
  }

  async assertReady(accountKey: string): Promise<void> {
    const config = this.options.getAccountConfig(accountKey)
    if (!config?.proxyUrl?.trim()) {
      return this.fail(accountKey, '必须先配置独立代理，系统不会回落到本机直连')
    }
    if (!validFingerprint(config.fingerprint)) {
      return this.fail(accountKey, '设备指纹未生成，无法打开平台连接')
    }
    try {
      const normalized = normalizeProxyForAccount(accountKey, config.proxyUrl)
      const verification = config.proxyVerification
      const verified = verification?.proxyHash === proxyHash(normalized) ? verification : undefined
      this.publish({
        accountKey,
        status: 'ready',
        ...(verified ? {
          exitIp: verified.exitIp,
          latencyMs: verified.latencyMs,
          checkedAt: verified.checkedAt
        } : { detail: '代理已配置，连接结果由平台返回' })
      })
    } catch (error) {
      return this.fail(accountKey, messageOf(error))
    }
  }

  startMonitoring(_accountKey: string, _onUnavailable: (detail: string) => void): void {
    // 不再用第三方探测结果中断一个实际可用的平台连接。平台连接及所有后续请求
    // 本身都固定走该代理，断开时只会报错，不存在本机直连回退路径。
  }

  stopMonitoring(_accountKey: string): void {}

  stopAll(): void {}

  private stateFromConfig(accountKey: string): AccountNetworkState {
    const config = this.options.getAccountConfig(accountKey)
    if (!config || !validFingerprint(config.fingerprint) || !config.proxyUrl?.trim()) {
      return {
        accountKey,
        status: 'unconfigured',
        detail: !config?.proxyUrl?.trim() ? '登录前必须配置独立代理' : '设备指纹尚未生成'
      }
    }
    try {
      const currentHash = proxyHash(normalizeProxyForAccount(accountKey, config.proxyUrl))
      const verification = config.proxyVerification
      if (verification?.proxyHash === currentHash) {
        return {
          accountKey,
          status: 'ready',
          exitIp: verification.exitIp,
          latencyMs: verification.latencyMs,
          checkedAt: verification.checkedAt
        }
      }
      // 手动检测不是保存或连接的前置条件；代理格式有效即可交给平台尝试。
      normalizeProxyForAccount(accountKey, config.proxyUrl)
      return { accountKey, status: 'ready', detail: '代理已配置，尚未手动检测' }
    } catch (error) {
      return { accountKey, status: 'blocked', detail: messageOf(error) }
    }
  }

  private fail(accountKey: string, detail: string): never {
    this.publish({ accountKey, status: 'blocked', detail })
    throw new Error(detail)
  }

  private publish(state: AccountNetworkState): void {
    this.states.set(state.accountKey, state)
    this.options.onState(state)
  }
}

export async function probeThroughProxy(
  _backendUrl: string,
  _token: string,
  proxyUrl: string,
  requestTarget: ProxyTargetRequest = requestProbeTarget
): Promise<{ latencyMs: number }> {
  // 同时访问全部容错目标，任何一个先经代理返回 HTTP 响应即判定可用。
  // 其余请求随即取消；整个过程中没有本机直连回退。
  const controller = new AbortController()
  const attempts = PROXY_PROBE_TARGETS.map((target) => Promise.resolve().then(
    () => requestTarget(proxyUrl, target, controller.signal)
  ))
  try {
    return await Promise.any(attempts)
  } catch {
    throw new Error('网络错误')
  } finally {
    controller.abort()
  }
}

async function requestProbeTarget(
  proxyUrl: string,
  target: ProxyProbeTarget,
  signal: AbortSignal
): Promise<{ latencyMs: number }> {
  const endpoint = new URL(target.url)
  const agent = createRequiredProxyAgent(proxyUrl)
  const startedAt = performance.now()

  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined
    let response: IncomingMessage | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
      response?.destroy()
      agent.destroy()
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
      const latencyMs = performance.now() - startedAt
      cleanup()
      resolve({ latencyMs })
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const cancel = (): void => {
      request?.destroy(new Error('检测取消'))
      fail(new Error('检测取消'))
    }
    const onResponse = (incoming: IncomingMessage): void => {
      response = incoming
      const status = incoming.statusCode ?? 0
      // 2xx/3xx 以及目标站点返回的 4xx 都证明代理链路已经打通；
      // 排除代理鉴权失败 407 和服务器/网关错误 5xx。
      if (status < 200 || status >= 500 || status === 407) {
        incoming.resume()
        fail(new Error(`${target.name} HTTP ${status}`))
        return
      }
      succeed()
    }

    if (signal.aborted) {
      fail(new Error('检测取消'))
      return
    }
    signal.addEventListener('abort', cancel, { once: true })
    const options = {
      agent,
      headers: {
        accept: '*/*',
        'user-agent': 'Mozilla/5.0 (compatible; WzzScrm-Proxy-Check/1.0)'
      }
    }
    try {
      request = endpoint.protocol === 'https:'
        ? httpsGet(endpoint, options, onResponse)
        : httpGet(endpoint, options, onResponse)
      request.once('error', fail)
      timeout = setTimeout(() => request?.destroy(new Error('代理检测超时')), 3_000)
    } catch (error) {
      fail(error)
    }
  })
}

async function probeTelegramThroughSocks(proxyUrl: string): Promise<number> {
  const proxy = createRequiredSocksProxyConfig(proxyUrl)
  const startedAt = performance.now()
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const connection = SocksClient.createConnection({
    proxy: {
      host: proxy.ip,
      port: proxy.port,
      type: proxy.socksType,
      userId: proxy.username,
      password: proxy.password
    },
    command: 'connect',
    destination: { host: '149.154.167.50', port: 443 },
    timeout: 3_000
  }).then((result) => {
    if (expired) {
      result.socket.destroy()
      throw new Error('代理检测超时')
    }
    return result
  })

  try {
    const { socket } = await Promise.race([
      connection,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true
          reject(new Error('代理检测超时'))
        }, 3_000)
      })
    ])
    socket.destroy()
    return Math.max(0, Math.round(performance.now() - startedAt))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizeExitIp(raw: string): string {
  const value = raw.trim().replace(/^::ffff:/, '')
  if (!isIP(value)) throw new Error('检测端点返回了无效出口 IP')
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
