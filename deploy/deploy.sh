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

# ── SSH 连接复用（ControlMaster）──
# 服务器装了 fail2ban：短时间多次新建 22 端口连接会被判为暴力破解并封 IP（握手即断）。
# deploy 有 8+ 次 ssh/scp/rsync，逐个新建连接必被封。这里先建一条 master 长连接，
# 后续所有 ssh/scp/rsync 都复用它（-o ControlPath），全程只有 1 次 TCP 握手 + 1 次鉴权，
# fail2ban 看不到连接风暴。ControlPersist 让 socket 在收尾后仍存活一会儿。
SOCK="${OMNI_SSH_SOCK:-/tmp/omni-deploy-%r@%h:%p}"
SSHM=(-o ControlMaster=auto -o "ControlPath=$SOCK" -o ControlPersist=300 \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
ssh() { command ssh "${SSHM[@]}" "$@"; }
scp() { command scp "${SSHM[@]}" "$@"; }
RSH="command ssh ${SSHM[*]}"
cleanup() { command ssh "${SSHM[@]}" -O exit "$SERVER" 2>/dev/null || true; }
trap cleanup EXIT
echo "==> [0] 建立复用连接（ControlMaster，避免 fail2ban 因连接风暴封 IP）"
ssh -o ConnectTimeout=15 "$SERVER" 'echo master-up' >/dev/null

echo "==> [1/7] 检查服务器前置（node/caddy/编译工具）；缺则自动 bootstrap"
# 先看缺什么。缺 Node/编译工具/Caddy 就跑 bootstrap.sh（同一 socket，幂等）。env 必须用户先填好。
NEED_BOOT=$(ssh "$SERVER" 'ok=1
  command -v node >/dev/null && node -e "process.exit(process.versions.node.split(\".\").map(Number)[0]>=22?0:1)" || ok=0
  command -v gcc >/dev/null && command -v make >/dev/null || ok=0
  command -v caddy >/dev/null || ok=0
  echo $ok') || true
if [ "${NEED_BOOT:-0}" != "1" ]; then
  echo "  前置不全，自动执行 bootstrap（首次会装几分钟）…"
  ssh "$SERVER" 'bash -s' < "$REPO_ROOT/deploy/bootstrap.sh"
fi
ssh "$SERVER" 'set -e
  command -v node >/dev/null || { echo "bootstrap 后仍缺 node"; exit 1; }
  node -e "process.exit(process.versions.node.split(\".\").map(Number)[0] >= 22 ? 0 : 1)" \
    || { echo "Node 版本过低（需 ≥22.18）"; exit 1; }
  test -f /etc/omnichat/omnichat.env || { echo "缺 /etc/omnichat/omnichat.env（照 deploy/omnichat.env.example 填好强密码/令牌）"; exit 1; }
  echo "  前置 OK：$(node -v)$(command -v caddy >/dev/null && echo " + caddy" || echo " (无 caddy)")"'

echo "==> [2/7] 同步后端代码到 /opt/omnichat/server"
ssh "$SERVER" 'mkdir -p /opt/omnichat/server /var/lib/omnichat'
rsync -az --delete -e "$RSH" \
  --exclude node_modules --exclude data --exclude '*.db' \
  server/ "$SERVER:/opt/omnichat/server/"

echo "==> [3/7] 安装后端依赖（含 better-sqlite3 原生编译）"
ssh "$SERVER" 'cd /opt/omnichat/server && npm install --omit=dev'

echo "==> [4/7] 本地构建管理后台（BRAND=prod）并同步到 /var/www/omnichat-admin"
( cd admin && BRAND=prod npm install && BRAND=prod npm run build )
ssh "$SERVER" 'mkdir -p /var/www/omnichat-admin'
rsync -az --delete --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r -e "$RSH" admin/dist/ "$SERVER:/var/www/omnichat-admin/"

echo "==> [5/7] 同步官网到 /var/www/omnichat-site"
ssh "$SERVER" 'mkdir -p /var/www/omnichat-site'
rsync -az --delete --exclude '._*' --exclude 'downloads/**' --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r -e "$RSH" website/ "$SERVER:/var/www/omnichat-site/"
if compgen -G "client/release/default/*.dmg" >/dev/null; then
  echo "  同步 macOS 安装包（Apple 芯片 / Intel）"
  ssh "$SERVER" 'mkdir -p /var/www/omnichat-site/downloads'
  rsync -az --delete \
    --include '*.dmg' --include '*.exe' --include '*.blockmap' --include 'latest-mac.yml' --exclude '*' \
    --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
    -e "$RSH" client/release/default/ "$SERVER:/var/www/omnichat-site/downloads/"
else
  echo "  未找到 client/release/default/*.dmg，保留服务器上已有下载包"
fi

echo "==> [6/7] 安装/更新 systemd 单元与 Caddyfile"
scp deploy/omnichat.service "$SERVER:/etc/systemd/system/omnichat.service"
scp deploy/Caddyfile "$SERVER:/etc/caddy/Caddyfile"
ssh "$SERVER" 'systemctl daemon-reload && systemctl enable --now omnichat && systemctl restart omnichat
  command -v caddy >/dev/null && { caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy || systemctl restart caddy; } || true'

echo "==> [7/7] 健康检查"
ssh "$SERVER" 'sleep 2; systemctl is-active omnichat && curl -fsS http://127.0.0.1:8787/health || curl -fsS http://127.0.0.1:8787/ >/dev/null && echo "  后端在 127.0.0.1:8787 响应"'
echo "完成。官网：https://www.wzzapp.cloud  公开看板：https://wzzapp.cloud/c/<token>  管理后台：https://admin.wzzapp.cloud"
