import { app } from 'electron'
import type { Logger } from './logger'
import { noopLogger } from './logger'

/** 推给渲染进程的更新状态 */
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'uptodate'
  /** 新版本号（available 起有值） */
  version?: string
  /** 下载进度 0-100 */
  percent?: number
  error?: string
}

export interface UpdaterDeps {
  /** 更新源地址（后台 /updates）；空 = 未配置，禁用检查 */
  feedUrl: () => string
  onState: (state: UpdateState) => void
  logger?: Logger
}

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * 自动更新（electron-updater，generic provider 指向自家后台）。
 *
 * "无感升级"的取舍：
 * - 静默下载（autoDownload），不打断客服正在进行的会话
 * - **不弹窗强制重启** —— 下载完成只发一条温和的状态给界面，
 *   真正的安装发生在用户下次退出时（autoInstallOnAppQuit）。
 *   聊天软件里"立即重启"弹窗是最招人烦的设计。
 * - 开发模式（未打包）下自动禁用，避免每次 npm run dev 都去请求更新源
 */
export class AppUpdater {
  private readonly deps: UpdaterDeps
  private readonly log: Logger
  private timer: ReturnType<typeof setInterval> | undefined
  private started = false
  state: UpdateState = { status: 'idle' }

  constructor(deps: UpdaterDeps) {
    this.deps = deps
    this.log = (deps.logger ?? noopLogger).child('updater')
  }

  /** 启动：绑定事件 + 立即检查一次 + 定时检查 */
  async start(): Promise<void> {
    if (this.started) return
    if (!app.isPackaged) {
      this.log.info('开发模式，自动更新禁用')
      return
    }
    const feed = this.deps.feedUrl()
    if (!feed) {
      this.log.info('未配置更新源，自动更新禁用')
      return
    }
    this.started = true

    // 动态 import：electron-updater 初始化会读 app-update.yml，
    // 开发模式下没有该文件会告警，按需加载避免噪音
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null

    autoUpdater.on('checking-for-update', () => this.emit({ status: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      this.emit({ status: 'available', version: info.version })
    )
    autoUpdater.on('update-not-available', () => this.emit({ status: 'uptodate' }))
    autoUpdater.on('download-progress', (p) =>
      this.emit({ status: 'downloading', version: this.state.version, percent: Math.round(p.percent) })
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.emit({ status: 'ready', version: info.version })
    )
    autoUpdater.on('error', (err) => {
      // 更新失败绝不能影响主功能；记日志、报状态，下个周期再试
      this.log.warn('更新检查失败', { err: String(err) })
      this.emit({ status: 'error', error: err.message })
    })

    const check = (): void => {
      void autoUpdater.checkForUpdates().catch(() => undefined)
    }
    check()
    this.timer = setInterval(check, CHECK_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** 手动检查（托盘菜单/设置页按钮） */
  async checkNow(): Promise<void> {
    if (!this.started) {
      await this.start()
      return
    }
    const { autoUpdater } = await import('electron-updater')
    void autoUpdater.checkForUpdates().catch(() => undefined)
  }

  /** 用户主动选择"立即重启更新"（ready 状态下才有意义） */
  async quitAndInstall(): Promise<void> {
    if (this.state.status !== 'ready') return
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.quitAndInstall()
  }

  private emit(state: UpdateState): void {
    this.state = { ...this.state, ...state }
    this.deps.onState(this.state)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
