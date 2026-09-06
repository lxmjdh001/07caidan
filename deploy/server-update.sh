#!/usr/bin/env bash
# 在服务器的 Git 工作树中构建并切换生产服务；不接触 /etc 密钥和 /var/lib 业务数据。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "==> [1/7] 检查服务器运行环境"
bash deploy/bootstrap.sh
test -f /etc/omnichat/omnichat.env || {
  echo "缺少 /etc/omnichat/omnichat.env，请先按 deploy/omnichat.env.example 配置" >&2
  exit 1
}
chmod 600 /etc/omnichat/omnichat.env
install -d -m 0700 /var/lib/omnichat
find /var/lib/omnichat -maxdepth 1 -type f -name 'omnichat.db*' -exec chmod 600 {} +

echo "==> [2/7] 安装后端生产依赖"
(cd server && npm ci --omit=dev)

echo "==> [3/7] 构建管理后台"
(cd admin && npm ci && BRAND=prod npm run build)
mkdir -p /var/www/omnichat-admin
rsync -a --delete --exclude '._*' admin/dist/ /var/www/omnichat-admin/
find /var/www/omnichat-admin -type d -exec chmod 755 {} +
find /var/www/omnichat-admin -type f -exec chmod 644 {} +

echo "==> [4/7] 发布官网（保留现有安装包）"
mkdir -p /var/www/omnichat-site/downloads
rsync -a --delete --exclude 'downloads/' --exclude '._*' website/ /var/www/omnichat-site/
find /var/www/omnichat-site -type d -exec chmod 755 {} +
find /var/www/omnichat-site -type f -exec chmod 644 {} +

echo "==> [5/7] 配置 UZF USDT 自动查账"
if [[ -f /etc/omnichat/uzf.json ]]; then
  chmod 600 /etc/omnichat/uzf.json
  python3 -m venv /opt/omnichat/uzf-venv
  /opt/omnichat/uzf-venv/bin/pip install --disable-pip-version-check -r services/uzf/requirements.txt
  install -m 0644 deploy/uzf-monitor.service /etc/systemd/system/uzf-monitor.service
  install -m 0644 deploy/uzf-query.service /etc/systemd/system/uzf-query.service
else
  echo "    /etc/omnichat/uzf.json 尚未配置，USDT 自动查账服务暂不启动"
fi

echo "==> [6/7] 备份数据库并更新 systemd 与 Caddy"
install -m 0755 deploy/backup.sh /usr/local/sbin/wzzscrm-backup
install -m 0644 deploy/omnichat.service /etc/systemd/system/omnichat.service
install -m 0644 deploy/omnichat-backup.service /etc/systemd/system/omnichat-backup.service
install -m 0644 deploy/omnichat-backup.timer /etc/systemd/system/omnichat-backup.timer
install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
if [[ -f /etc/omnichat/uzf.json ]]; then
  systemctl enable --now uzf-monitor uzf-query
  systemctl restart uzf-monitor uzf-query
fi
systemctl enable --now omnichat-backup.timer
systemctl start omnichat-backup.service
systemctl enable --now omnichat
systemctl restart omnichat
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "==> [7/7] 健康检查"
for _attempt in $(seq 1 20); do
  if systemctl is-active --quiet omnichat && curl -fsS http://127.0.0.1:8787/health; then
    printf '\n后端就绪；版本 %s\n' "$(git rev-parse --short=12 HEAD)"
    exit 0
  fi
  sleep 1
done

echo "后端 20 秒内未就绪" >&2
systemctl status omnichat --no-pager -l >&2 || true
exit 1
