import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'

/** 自绘标题栏高度，与渲染层 styles.css 的 --titlebar-h 保持一致 */
export const TITLEBAR_HEIGHT = 40

export function createMainWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 620,
    title: 'OmniChat',
    backgroundColor: '#1f2430',
    // 两个平台都隐藏原生标题栏，由渲染层自绘：
    // - macOS: hiddenInset 保留原生红绿灯（内嵌位置），标题栏左侧留白
    // - Windows: titleBarOverlay 由系统绘制 最小化/最大化/关闭 按钮（深色配色），标题栏右侧留白
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    ...(isWin
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#1f2430',
            symbolColor: '#e8eaf0',
            height: TITLEBAR_HEIGHT
          }
        }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  // Windows/Linux 不显示传统菜单栏（功能都在自绘标题栏与界面里）
  if (!isMac) win.setMenuBarVisibility(false)

  // 外链交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}
