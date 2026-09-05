#!/usr/bin/env bash
# 一次性服务器初始化：装 Git、Node 22、编译工具（better-sqlite3 原生模块要）、Caddy，
# 并建好 /etc/omnichat。幂等，可重复跑。
#
# 用法（二选一）：
#   A) 从本地经 SSH 跑：  ssh root@SERVER 'bash -s' < deploy/bootstrap.sh
#   B) 在服务器控制台里：  把本文件内容贴进去执行
#
# 跑完后：把 deploy/omnichat.env.example 复制到 /etc/omnichat/omnichat.env 填好，
# 再在本地仓库根跑 deploy/deploy.sh。
set -euo pipefail

echo "==> 探测发行版与包管理器"
if   command -v apt-get >/dev/null; then PM=apt
elif command -v dnf     >/dev/null; then PM=dnf
elif command -v yum     >/dev/null; then PM=yum
else echo "未知包管理器（非 apt/dnf/yum），请手动装 Node22+编译工具+Caddy"; exit 1
fi
echo "    包管理器：$PM"

echo "==> 安装 Git 与 rsync（服务器从统一仓库更新）"
if command -v git >/dev/null && command -v rsync >/dev/null; then
  echo "    已安装，跳过"
else
  case "$PM" in
    apt) apt-get update && apt-get install -y git rsync ;;
    dnf|yum) "$PM" install -y git rsync ;;
  esac
fi

install_node_apt() {
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
}
install_node_rpm() {
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  "$PM" install -y nodejs
}

echo "==> 安装 Node 22（若已有 ≥22 则跳过）"
if command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)'; then
  echo "    已有 $(node -v)，跳过"
else
  case "$PM" in apt) install_node_apt;; dnf|yum) install_node_rpm;; esac
  echo "    装好 $(node -v)"
fi

echo "==> 安装编译工具（better-sqlite3 原生编译）"
case "$PM" in
  apt) apt-get install -y build-essential python3 ;;
  dnf|yum) "$PM" groupinstall -y "Development Tools" || "$PM" install -y gcc gcc-c++ make; "$PM" install -y python3 ;;
esac

echo "==> 安装 Caddy（自动 HTTPS 反代）"
if command -v caddy >/dev/null; then
  echo "    已有 $(caddy version | head -c40)，跳过"
else
  case "$PM" in
    apt)
      apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update && apt-get install -y caddy ;;
    dnf|yum)
      "$PM" install -y 'dnf-command(copr)' || true
      "$PM" copr enable -y @caddy/caddy || true
      "$PM" install -y caddy ;;
  esac
fi

echo "==> 建配置目录 /etc/omnichat 与数据目录 /var/lib/omnichat"
mkdir -p /etc/omnichat /var/lib/omnichat /etc/caddy /var/www/omnichat-admin /var/www/omnichat-site

echo ""
echo "完成。下一步："
echo "  1) 把 deploy/omnichat.env.example 复制到 /etc/omnichat/omnichat.env 并填好强密码/令牌"
echo "  2) 本地仓库根跑：deploy/deploy.sh"
