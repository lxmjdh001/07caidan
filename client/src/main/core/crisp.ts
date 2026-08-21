import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, app } from 'electron'
import { brand } from '@shared/branding'

/**
 * Crisp 在线客服（M20）。
 *
 * Electron 里不把 Crisp 塞进主窗口（主窗口 CSP 严格、且 widget 会盖住聊天 UI），
 * 而是开一个独立 BrowserWindow 加载本地生成的 HTML，页面里按官方 embed 方式
 * 挂 widget。Website ID 由后台 /api/client/config 下发 —— 贴牌部署各配各的，
 * 未配置则客户端根本不显示入口。
 *
 * 会话自定义数据（session:data）带上套餐/到期/余额/版本/系统/设备指纹，
 * 客服人员一眼看到用户环境，不用来回问。
 */

export interface CrispSessionData {
  email?: string
  /** [key, value] 对；值只放非隐私的运营数据 */
  data: Array<[string, string]>
}

/**
 * 内联 <script> 里嵌 JSON：JSON.stringify 不转义 `</script>`（`/` 不在转义集），
 * HTML 解析器遇到字符串里的 `</script>` 会提前关闭脚本块 → 后面可塞入可执行标签（注入）。
 * 把 `<` 转成 `<`（仍是合法 JSON、语义不变）即可杜绝 `</script>` 与 `<!--` 突破。
 * session.data 里含管理员可配的套餐名等，属可控输入，必须走这里。
 */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c')
}

/** 生成独立客服窗口加载的 HTML（纯函数，便于测试） */
export function buildCrispHtml(websiteId: string, session: CrispSessionData): string {
  const pairs = jsonForScript(session.data)
  const emailPush = session.email
    ? `$crisp.push(["set","user:email",[${jsonForScript(session.email)}]]);`
    : ''
  // websiteId 只允许 UUID 形态，杜绝注入
  if (!/^[a-f0-9-]{10,64}$/i.test(websiteId)) throw new Error('非法的 Crisp Website ID')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(brand.appName)} - Support</title>
<style>html,body{margin:0;height:100%;background:#f7f7f8;font-family:system-ui}
.tip{color:#888;font-size:13px;padding:16px;text-align:center}</style>
</head>
<body>
<p class="tip">Loading support chat…</p>
<script type="text/javascript">
window.$crisp=[];window.CRISP_WEBSITE_ID=${JSON.stringify(websiteId)};
${emailPush}
$crisp.push(["set","session:data",[${pairs}]]);
$crisp.push(["do","chat:open"]);
(function(){var d=document,s=d.createElement("script");
s.src="https://client.crisp.chat/l.js";s.async=1;
d.getElementsByTagName("head")[0].appendChild(s);})();
</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

let win: BrowserWindow | null = null

/** 打开（或聚焦）客服窗口 */
export async function openCrispWindow(websiteId: string, session: CrispSessionData): Promise<void> {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  const html = buildCrispHtml(websiteId, session)
  const file = join(app.getPath('userData'), 'crisp.html')
  await writeFile(file, html, 'utf8')
  win = new BrowserWindow({
    width: 420,
    height: 640,
    title: `${brand.appName} Support`,
    autoHideMenuBar: true,
    webPreferences: {
      // 客服页是我们自己生成的静态壳 + Crisp 官方脚本，不需要任何 Node 能力
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  win.on('closed', () => {
    win = null
  })
  await win.loadFile(file)
}
