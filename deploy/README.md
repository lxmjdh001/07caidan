# 部署到生产服务器

目标：`wzzapp.cloud`（API + 公开引流看板）、`admin.wzzapp.cloud`（管理后台）。
后端只绑回环 `127.0.0.1:8787`，外网经 Caddy 反代终止 TLS。

## 首次准备（服务器上手动跑一次）

```bash
# 1) 安装 Node ≥ 22.18（type-stripping 稳定版）、编译工具、Caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
apt-get install -y build-essential python3            # better-sqlite3 原生编译
apt-get install -y caddy                              # 若源里没有，见 caddyserver.com 官方源

# 2) 放好环境变量（照模板填强密码/令牌）
mkdir -p /etc/omnichat
#   把 deploy/omnichat.env.example 复制过去改名 omnichat.env，填 OMNI_ADMIN_PASSWORD / OMNI_TOKENS 等
```

## 部署 / 更新（本地仓库根运行，幂等）

```bash
deploy/deploy.sh
# 覆盖默认 SSH 目标：OMNI_SSH=root@1.2.3.4 deploy/deploy.sh
```

脚本做：检查前置 → rsync 后端到 `/opt/omnichat/server` → `npm install --omit=dev` →
本地 `BRAND=prod` 构建 admin 并同步到 `/var/www/omnichat-admin` → 装 systemd 单元与 Caddyfile →
重启 `omnichat` 与 `caddy` → 健康检查 `/health`。

## 客户端打包（对接生产域名）

`branding/prod.json` 的 `apiUrl` 已指向 `https://wzzapp.cloud`：

```bash
cd client && BRAND=prod npm run build      # 产物 out/ 内已烘入 https://wzzapp.cloud
# 再按平台走 electron-builder 出安装包
```

## 安全须知（务必）

- **改 root 密码 + 换 SSH 密钥登录**（密码此前明文传过）。
- `OMNI_TRUST_PROXY=true` 仅在后端绑回环 + 只有 Caddy 能连时才安全——本配置即如此。
  若把后端直接暴露公网，须关掉，否则地区限制的 `X-Forwarded-For` 可被伪造。
- `omnichat.env` 含密码/令牌，**不要提交进仓库**（仓库只放 `.example`）。
