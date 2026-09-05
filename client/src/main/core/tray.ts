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
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA50lEQVR42rXSvUoDURAF4C+7isS8QAqxSesPPo8vINgpllpY2FtZ+RxpbbVVbOx8AhETUNBrMwnDZWO1DizMnHPmnrO7l55rDYM/+EFo+q2F4xDHGFd47sehGWa8iWEPBbcxt8G18QiuhDbvLpspZtioEjSBzUKz3Gk6DtjEfjgd4QY/2A1uWrvnYRKLV1gPx4IdnEc/6TogA894wiW+8YY7vOBx1bL0f8/CqeAaF2k+rbSdCQ7whQ9sYRvv+AxuZYLFVx+F233iHgIb1XckRylBzHGI1yQ8iSTzwIr/rrZ6zybdxn7rF5KxLPeFqi7LAAAAAElFTkSuQmCC'
const TRAY_TEMPLATE_32 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAB8UlEQVR42u2WvUoDQRDHf3cXPyDERlHfQNTWItgKIoiW4mNYmMLKLk0Q38AINhZikcI3UKyttLARBAWxCaiJSc7mvzDEJHeXO7AwA8fezvf+Z3YZGNGI+pOn70/8WAM/RXC/j89YFAD5YY2NTV6+EsE1B1wDz8DKEEg43RX5uJbPyHLktJaBUN8DMJ4QBU82D8ZPuSvGwMxXgU+gBXSAoilLnNIhm458fMpnLCSdwq3JvtIn+6AHz+0rxv42SRlzgrBkHNz3KIMXAf+9sS+Jn0vSQAtAQw4a2ju5C74D7JvAQQzbRE3UfQqAScm3jexIsgmtUejFKkOvOnrAmGTnarIvNdqi5H7M/ondyW0FapggS8CHZE0FOpbNsnQ7kie5QZF3+UCyU+1bWjvAm/T3krwhfgQKTaBmeBvAFLBlgnwrgWlgF1g3+jX5CIZ4yn+VIQTegQtz6hvgxKDxAtS1TwX/oDK4U4e6hnN66dpdOsM84X1RqJrADvJHXUmAK8mbJrlq2tNb400DswtwaFBaM3LXmJtZJODgKwBPgrkFvAIz5t7ngDvJ29ItxJklop7GUDp1Qe7rRGe6doF4LeBS/7506/oP08507u0vmuFi1vAdCvNmiCkafqZkxysvYozLnKIGzKwG2VQjdlaj/Ij+Ef0A/w+cw1/b/L0AAAAASUVORK5CYII='
const TRAY_COLOR_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACyElEQVR42m2TT2hcdRDHP/P78/btbpYm2iamRIuFKmqIYCO2opdeDIRC8ZJDDr2aQsEePPQieKt4LBpP4sFCPXj0JElRtH8OOSZttyUX6WZjo2TTTd7ue7/3Gw+r0UBmYGAO3z8zwwjA0RsLp03qvyAv3yOqA4TDQzESSOyvsVd8sjW/uCLjNxZOB2d/tIkbM1nQUlUUPRQtCFZEY9VJmYdNF8pZE5TrNvFjoZuFrX5XCi2RQwwIQqElW/2uhG4WbOLHgnLdCHImdDOt+tRdmZzheG2YfiwOkAhCPxYcrw1zZXKGqk9d6GYqyBljjJF+DHKyMcq16TmuTp1nL+QYIxgRrBiMEfZCztWp81ybnuNkY5R+DGKMERM1Uvcp954+Zrm1xoUT0zyfDhHKkt0ip5NnFGXgaNrgwolplltr3Hv6mLpPiRoxAEaEECNLG6vUXMKbIy/xZ9bho9fO8dW7F9np7zI5MkHNJSxtrBJixMhgRAMQY6RmE5ZaqwDMTEwxnDb47K0PuXjqfd4Ze4Vz468DsNRapWYTYowAOICIUvWete0nNDttZiamiCgV43lWZHz+9hwvVIe5v91ibfsJNZ8QVf9zAGDF0gsFN9fv8OqRcT5+4wO+af7M1w+WOTt6ipcbx/h+/S69UGDF7l9onyCqUrGOX9oPKWJJFgq+vP8TN9fv0i165DHw2x9NEuv21Q8QqA4sP9pp443lYadFs9PmwXaLR882SYyj2WmTGo/+j8ANOkFFxRnDTp5x6fa3/L77F946AD5d+YEX68+xk2dUrENR/i1y7LuF26aentVuL2DECUKn2MOLpeYqAOyFPoWWHPG1AS5qkKHUxd3eHeOEyzEvNmWo4lBUUUaSOnVfQf/Juq8wktT3lWWo4mJebDrhstmYX1zRUM5qjLewEgAtNR5YVFSl1Dh4ZytBY7yloZzdmF9c+RuYTFwEzbtWkgAAAABJRU5ErkJggg=='
const TRAY_COLOR_32 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAGRUlEQVR42rWXW2xU1xWGv7XP2XM8ngGbdMaQgJvEIDUQmYvKRSWoKFEIalFa9cGoD7Rq3aiiCqqE+lhVqEpe+1ZUglAqRc2LSRU1kmkuErQRJVUMMnQCFJQYUssmtifYZmY8PnPO2asPg6c2F5sAXU+jrbP3+uf/17/22gJAT5fH7qMJB7b7bWvWvYToT4ndBlQtDyNEInzTj8ofRy+cO8Jv/x7P5JSZH7kjezd4ranfY8xWYodGMQ8zxPrgG3DuVDJR21d86VA/PV2eALT96eVOCcyH+F6rlsMEg4CYh4oAdThUsoFHnExo6L49uudgQdb0dKWKUe4f0hxs1EotQrD8P0OJJJOyOhWeztniM6ZYy3VLOtio5TCZnVwAQR6c+ltPEayWw0TSwcZiLddtHOwldlqnvR5GBIcSa4KR+wdhRIg1waFzzzEIsVMHe40RntYobmguIlTjGp54LLJpKlF4XyCMCJUoZJFN44lHNa4hjXPEaBSLEZ42IP5sumKX0JZu4Z3n9/PRiwfYnF95E4T5CskNlShkc34lH714gHee309buoXYJbcIIv6cUz1jmAin2Ld6B5vyHSxLt/Datm4Cz+LU3TMAp47As7y2rZtl6RY25TvYt3oHE+EUnpn7R8zcjUraT/HBcIEwiXDq6Mjm2ZzvoByFePfAgieGchSyOd9BRzaPU0eYRHwwXCDtp3Cq8wFwZG3AiWsX+WR8CCMGEWFX+3oiF8/S8H/J/FtAiQiRi9nVvh4RwYjhk/EhTly7SNYGtzFp7qRfzSX0DvY31l5Y3smSIEPs4jlFNlGbYiws3bRsPWIXsyTI8MLyzsa3vYP91Fxyxzq6bcU5pcn4vDdUIHIJAI9nc6xavJRqHGEQjAilaJo9K7fy63Xfo+ZmrGaoxhGrFi/l8WwOgMglvDdUoMn4OKe3AfBvA4Aj7Vs+vTHC5+UiqxYvxRqPncs76RsboDVo5svpMj94YhOHt/0MgKXpFvb/803yTYuZTiJ2Lu/EGg+Az8tFPr0xQtq3ONzCDAD4xmc8rPD+UKGxtqt9A81+ikSV2CV0PbEZRam5mJ9/41m+mXuSG1GVrG1iV/uGxr73hwqMhxV849/Zsnds16qkjE/v4FlUFUVZ+8gKOpe0c326xJa2lexc0YlqvXcYMfx41TNMhiU6l7Sz9pEVKIqq0jt4lpTxUdV7B5Coo9mmOFO8wkBpFEGwxuc77euYDiu8vHoHTZ5FUazxUJSuJ7eQT7eyfdlTWOMjCAOlUc4Ur9BsUyR36SN3NbY1PtfDCu/OkuHZR9fw9dbH2LliLQooSuQSVGFJkOGHK7/F9kefanz/7lCB62EFexf65wUwI8OxmzIArGl9jD9s/QmtqWYAzn75H966+jFGhESV36z/PlvaVjX2H1uA/nkBzJGhPAZASyrNd9vXEzuHAIcvHefV/r8QJhEC5JsWk/VTAAyUxxakf14AdTd4jNem6BsbuNlkHLEmeMZwtVykd/Acn5VGODlyuX71uoTY1ZP1jQ0wXpvCv2nH+wKA1q/uma5oREDr99nRKx9zfbpM4FkO/ft4o4vOtOvewf76iKHcPwCnSsYGnBy5zPDUeH26EShOlzhy6QTNNiDtp/jbtYtcmBhqzBrDU+OcHLlMxga3XT5fCYBSL8SR6iRXykVEBE8Mb13t47PSKE2exRPDeK3CXwf/hRFBRLhSLjJSnawXIA8AYDaIV/rf5ovqJH1jA/yucIzWVDOJcyTO0Zpq5vCl4/SNDfBFdZJX+t++p+QA0vbmL6LZU9HdBstKHJJrWsR0EjGd1Ag827CXiDAdR6T9FE2epThdIuMH9wBAY+OU82J9hbt7RVGyNqAUVUk0qXfBWdqqKmnfkmhCKaqStQslVyfWV6ecNwYO4Zv6GLxAQfriYZA7FpbT+mDti7dg4eFQfCMGDplcqvi6VsPTkg08lGihetD5Xbsw7Uok2cDTang6lyq+bi7sPlpDTTdxMiGZlMVpMp8cD/Y000QyKUucTKCm+8LuozVDT5c3uudgIZmMniNxpyQTeGKtedjpxVojmcAjcaeSyei50T0HC/R0eR5HLyg9Xd7Uj94YrqxueiPztaXXEG1DaQO8h/Y8N3KGhFdHz5/75dSv/jw88yr/L/GJ+IdUg3fBAAAAAElFTkSuQmCC'

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
