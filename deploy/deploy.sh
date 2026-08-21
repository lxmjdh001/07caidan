#!/usr/bin/env bash
# OmniChat 一键部署到生产服务器。从仓库根运行：deploy/deploy.sh
# 幂等：可反复执行做更新（rsync 增量 + 重启 systemd）。
#
# 前置（首次，需在服务器上手动完成一次，脚本会检测并提示）：
#   - Node ≥ 22.18、build-essential/python3（better-sqlite3 原生编译）、caddy
#   - /etc/omnichat/omnichat.env 已按 omnichat.env.example 填好
set -euo pipefail

SERVER="${OMNI_SSH:-root@187.77.129.250}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> [1/6] 检查服务器前置（node/caddy/编译工具）"
ssh "$SERVER" 'set -e
  command -v node >/dev/null || { echo "缺 node，请先装 Node ≥ 22.18"; exit 1; }
  node -e "process.exit(process.versions.node.split(\".\").map(Number)[0] >= 22 ? 0 : 1)" \
    || { echo "Node 版本过低（需 ≥22.18）"; exit 1; }
  command -v caddy >/dev/null || echo "警告：未装 caddy，稍后需手动装并加载 Caddyfile"
  command -v make  >/dev/null || echo "警告：缺 build-essential，better-sqlite3 可能编译失败"
  test -f /etc/omnichat/omnichat.env || { echo "缺 /etc/omnichat/omnichat.env（照 deploy/omnichat.env.example 填）"; exit 1; }
  echo "  前置 OK：$(node -v)"'

echo "==> [2/6] 同步后端代码到 /opt/omnichat/server"
ssh "$SERVER" 'mkdir -p /opt/omnichat/server /var/lib/omnichat'
rsync -az --delete \
  --exclude node_modules --exclude data --exclude '*.db' \
  server/ "$SERVER:/opt/omnichat/server/"

echo "==> [3/6] 安装后端依赖（含 better-sqlite3 原生编译）"
ssh "$SERVER" 'cd /opt/omnichat/server && npm install --omit=dev'

echo "==> [4/6] 本地构建管理后台（BRAND=prod）并同步到 /var/www/omnichat-admin"
( cd admin && BRAND=prod npm install && BRAND=prod npm run build )
ssh "$SERVER" 'mkdir -p /var/www/omnichat-admin'
rsync -az --delete admin/dist/ "$SERVER:/var/www/omnichat-admin/"

echo "==> [5/6] 安装/更新 systemd 单元与 Caddyfile"
scp deploy/omnichat.service "$SERVER:/etc/systemd/system/omnichat.service"
scp deploy/Caddyfile "$SERVER:/etc/caddy/Caddyfile"
ssh "$SERVER" 'systemctl daemon-reload && systemctl enable --now omnichat && systemctl restart omnichat
  command -v caddy >/dev/null && { caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy || systemctl restart caddy; } || true'

echo "==> [6/6] 健康检查"
ssh "$SERVER" 'sleep 2; systemctl is-active omnichat && curl -fsS http://127.0.0.1:8787/health || curl -fsS http://127.0.0.1:8787/ >/dev/null && echo "  后端在 127.0.0.1:8787 响应"'
echo "完成。公开看板：https://wzzapp.cloud/c/<token>  管理后台：https://admin.wzzapp.cloud"
