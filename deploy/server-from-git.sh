#!/usr/bin/env bash
# 由 deploy.sh 通过 SSH stdin 执行。首次安装 Git 并创建生产工作树，之后只做 fast-forward 更新。
set -euo pipefail

GIT_REPO="${1:-https://github.com/lxmjdh001/07caidan.git}"
GIT_BRANCH="${2:-main}"
REPO_DIR="/opt/omnichat/repo"

if [[ $(id -u) -ne 0 ]]; then
  echo "服务器部署必须以 root 执行" >&2
  exit 1
fi

install_git() {
  if command -v git >/dev/null && command -v rsync >/dev/null; then return; fi
  if command -v apt-get >/dev/null; then
    apt-get update
    apt-get install -y git rsync
  elif command -v dnf >/dev/null; then
    dnf install -y git rsync
  elif command -v yum >/dev/null; then
    yum install -y git rsync
  else
    echo "未知包管理器，请先安装 git 与 rsync" >&2
    exit 1
  fi
}

install_git
mkdir -p "$(dirname "$REPO_DIR")"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  if [[ -e "$REPO_DIR" ]] && [[ -n "$(find "$REPO_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "$REPO_DIR 已存在且不是空目录，拒绝覆盖" >&2
    exit 1
  fi
  git clone --branch "$GIT_BRANCH" --single-branch "$GIT_REPO" "$REPO_DIR"
else
  CURRENT_ORIGIN="$(git -C "$REPO_DIR" remote get-url origin)"
  if [[ "$CURRENT_ORIGIN" != "$GIT_REPO" ]]; then
    echo "服务器工作树 origin 不一致：$CURRENT_ORIGIN" >&2
    exit 1
  fi
  git -C "$REPO_DIR" fetch --prune origin "$GIT_BRANCH"
  git -C "$REPO_DIR" checkout "$GIT_BRANCH"
  git -C "$REPO_DIR" pull --ff-only origin "$GIT_BRANCH"
fi

exec bash "$REPO_DIR/deploy/server-update.sh"
