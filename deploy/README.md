# 生产部署

唯一代码仓库：`git@github.com:lxmjdh001/07caidan.git`。

- 本地开发使用 SSH `origin` 提交、拉取和推送。
- 服务器使用同一仓库的只读 HTTPS 地址，工作树固定为 `/opt/omnichat/repo`。
- 生产分支为 `main`，更新只允许 `fast-forward`，服务器不会覆盖未提交改动。
- 数据库、媒体、更新包位于 `/var/lib/omnichat`，生产密钥位于
  `/etc/omnichat/omnichat.env`；这些内容不进入 Git。

## 日常更新

先在本地提交并推送：

```bash
git add -A
git commit -m "描述本次修改"
git push origin main
```

再从仓库根目录部署：

```bash
deploy/deploy.sh
```

脚本会先确认本地 `HEAD` 已经推送，然后只建立一次 SSH 连接。服务器将：

1. 首次自动安装 Git/Node 22/编译工具/Caddy，并克隆仓库；
2. 后续从 `origin/main` 执行 `pull --ff-only`；
3. 安装后端生产依赖并在服务器构建管理后台；
4. 从该提交发布官网、systemd 服务和 Caddy 配置；
5. 重启服务并检查 `/health`。

可覆盖默认目标：

```bash
OMNI_SSH=root@1.2.3.4 deploy/deploy.sh
OMNI_GIT_BRANCH=staging deploy/deploy.sh
```

## 首次环境配置

真实配置只放服务器：

```bash
scp deploy/omnichat.env.example root@187.77.129.250:/etc/omnichat/omnichat.env
ssh root@187.77.129.250 'chmod 600 /etc/omnichat/omnichat.env'
```

然后编辑 `/etc/omnichat/omnichat.env`，至少替换管理员密码和同步令牌。

## 域名与目录

- `https://wzzapp.cloud`：API 与公开分享页
- `https://www.wzzapp.cloud`：官网与安装包下载
- `https://admin.wzzapp.cloud`：管理后台
- `/opt/omnichat/repo`：GitHub 生产工作树
- `/var/lib/omnichat`：数据库、媒体与更新包
- `/var/www/omnichat-admin`：管理后台构建产物
- `/var/www/omnichat-site`：官网静态文件（部署时保留 `downloads/`）

## 客户端安装包

客户端仍需在对应操作系统打包；安装包是构建产物，不提交 Git：

```bash
cd client
BRAND=prod UPDATE_URL=https://wzzapp.cloud/updates npm run dist
```

`OMNI_TG_API_ID` 与 `OMNI_TG_API_HASH` 放在被 Git 忽略的
`client/.env.production.local`，不要写入源码或提交仓库。

## 安全约束

- 优先使用 SSH 密钥登录服务器，并更换曾明文传递过的密码。
- 不提交 `.env`、会话文件、代理密码、数据库、媒体或安装包。
- 后端只监听 `127.0.0.1:8787`，公网统一经 Caddy 终止 TLS。
- 若以后把 GitHub 仓库改为私有仓库，应给服务器配置只读 Deploy Key，不能放个人令牌。
