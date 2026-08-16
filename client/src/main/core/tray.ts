import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { brand } from '@shared/branding'

/**
 * 系统托盘。
 *
 * 图标以 base64 内嵌而不是读资源文件 —— 打包后 asar 内外的路径差异
 * 是托盘图标"开发正常、打包后消失"的头号原因，内嵌一劳永逸。
 * macOS 用模板图（纯黑+透明），系统自动适配深浅菜单栏；Windows 用彩色。
 */
const TRAY_TEMPLATE_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR42mNgoBH4jwOTrZFogygy4D+JeNSAgTaAYcAMICoZU5SB6A8AA+6DfTj+TJIAAAAASUVORK5CYII='
const TRAY_TEMPLATE_32 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAXklEQVR42u2XMQ4AIAgD+f+ncTcxahROSZt0pTdBMftY3hkJHRkLDgHxQ6PhRxB+2Wj4FoQHWwBo+BRCAALAAbQHygO8fwnLAmBl5FoVM0ssoyuDUms4+nKhP5+UogZXNCD8YwecPQAAAABJRU5ErkJggg=='
const TRAY_COLOR_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVR42mNgoAVQWpD9HxsmWyPRBlFkALGacRoyagCdDaA4Gsk2gKhkTFEGYhgIAAA2uR7AGLhYZwAAAABJRU5ErkJggg=='
const TRAY_COLOR_32 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAa0lEQVR42u3XsREAIQhEUWqxPZuyU01NHBWBVYQZ4/+iOyB6dVLJtX+Q6OjBwioQblwEcRo/QkjFWQjp+BZCK76M+BugHZ8iAhAAOCC+A+4B9/8J3QJgy4jYKsaBqR4cpms49OSC3nwUYzQNQeKkQRy6/CMAAAAASUVORK5CYII='

export interface TrayDeps {
  getWindow: () => BrowserWindow | undefined
  /** 检查更新入口（由 updater 模块提供；未接入时为空） */
  checkUpdates?: () => void
  /** 当前版本号，展示在菜单里 */
  version: string
}

export class AppTray {
  private tray: Tray | undefined
  private readonly deps: TrayDeps
  private unread = 0
  /** 用户从托盘/菜单点了退出：此时关窗才是真退出 */
  quitting = false

  constructor(deps: TrayDeps) {
    this.deps = deps
  }

  create(): void {
    const isMac = process.platform === 'darwin'
    const b64 = isMac ? TRAY_TEMPLATE_16 : TRAY_COLOR_16
    const b64x2 = isMac ? TRAY_TEMPLATE_32 : TRAY_COLOR_32
    const image = nativeImage.createEmpty()
    image.addRepresentation({
      scaleFactor: 1,
      buffer: Buffer.from(b64, 'base64')
    })
    image.addRepresentation({
      scaleFactor: 2,
      buffer: Buffer.from(b64x2, 'base64')
    })
    if (isMac) image.setTemplateImage(true)

    this.tray = new Tray(image)
    this.tray.setToolTip(brand.appName)
    // 单击托盘：切换主窗口（Windows 习惯；macOS 上点图标弹菜单更常见，但显示窗口也不突兀）
    this.tray.on('click', () => this.showWindow())
    this.rebuildMenu()
  }

  /** 未读数变化：更新 tooltip 与菜单首行 */
  setUnread(count: number): void {
    if (count === this.unread) return
    this.unread = count
    if (!this.tray) return
    this.tray.setToolTip(count > 0 ? `${brand.appName} — ${count} 条未读` : brand.appName)
    this.rebuildMenu()
  }

  private rebuildMenu(): void {
    if (!this.tray) return
    const menu = Menu.buildFromTemplate([
      {
        label: this.unread > 0 ? `打开主界面（${this.unread} 条未读）` : '打开主界面',
        click: () => this.showWindow()
      },
      { type: 'separator' },
      {
        label: '检查更新…',
        enabled: !!this.deps.checkUpdates,
        click: () => this.deps.checkUpdates?.()
      },
      { label: `版本 ${this.deps.version}`, enabled: false },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          this.quitting = true
          app.quit()
        }
      }
    ])
    this.tray.setContextMenu(menu)
  }

  showWindow(): void {
    const win = this.deps.getWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = undefined
  }
}
