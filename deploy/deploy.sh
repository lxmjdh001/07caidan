#!/usr/bin/env bash
# 从 GitHub 部署 OmniChat。以后本地只负责 commit + push，服务器固定从同一仓库拉取。
# 从仓库根运行：deploy/deploy.sh
set -euo pipefail

SERVER="${OMNI_SSH:-root@187.77.129.250}"
GIT_REPO="${OMNI_GIT_REPO:-https://github.com/lxmjdh001/07caidan.git}"
GIT_BRANCH="${OMNI_GIT_BRANCH:-main}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! "$GIT_REPO" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]]; then
  echo "OMNI_GIT_REPO 只接受 GitHub HTTPS 仓库地址" >&2
  exit 1
fi
if [[ ! "$GIT_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "OMNI_GIT_BRANCH 格式无效" >&2
  exit 1
fi

cd "$REPO_ROOT"
LOCAL_REV="$(git rev-parse HEAD)"
REMOTE_REV="$(git ls-remote "$GIT_REPO" "refs/heads/$GIT_BRANCH" | awk 'NR == 1 { print $1 }')"
if [[ -z "$REMOTE_REV" ]]; then
  echo "远程分支 $GIT_BRANCH 不存在，请先把本地代码推送到 $GIT_REPO" >&2
  exit 1
fi
if [[ "$LOCAL_REV" != "$REMOTE_REV" ]]; then
  echo "本地 HEAD 尚未推送到 $GIT_BRANCH；请先 git push origin $GIT_BRANCH" >&2
  exit 1
fi

echo "==> 部署提交 ${LOCAL_REV:0:12} 到 $SERVER"
# 整个源码部署只建立一次 SSH 连接，避免服务器 fail2ban 把多次握手误判为爆破。
ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$SERVER" \
  bash -s -- "$GIT_REPO" "$GIT_BRANCH" \
  < "$REPO_ROOT/deploy/server-from-git.sh"

echo "完成。服务器已运行 GitHub $GIT_BRANCH @ ${LOCAL_REV:0:12}"
