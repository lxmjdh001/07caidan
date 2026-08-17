# 品牌配置（白牌打包）

同一份代码，构建时指定品牌即可产出不同名称/标识的客户端、管理后台与看板页。

## 用法

1. 复制 `default.json` 为 `<brand>.json`（如 `acme.json`），改里面的字段
2. 构建时指定品牌：

```bash
# 客户端
cd client  && BRAND=acme npm run build
# 管理后台
cd admin   && BRAND=acme npm run build
# 后端（运行时读取，无需构建）
cd server  && BRAND=acme npm start
```

不指定 `BRAND` 时用 `default.json`。

## 字段

| 字段 | 用在哪 |
|---|---|
| appName | 客户端窗口标题/标题栏、后台登录页与侧栏、看板页标题后缀 |
| logoText | 客户端登录卡片与后台侧栏的字母 Logo |
| shortName | 打包产物命名（预留给 electron-builder productName/appId） |
| themeColor | 预留：主题主色（当前主题色仍在 CSS 令牌中） |
| dashboardTitle | 公开看板页 `<title>` 与页头 |
| apiUrl | 后台 API 地址，打包进客户端；登录界面只填邮箱+密码，不再让用户填地址 |
| company / website / supportEmail | 预留：关于页与邮件署名 |

## 注意

- 三端读的是**同一份 JSON**，改名只改一处，不会出现"客户端改了后台忘了"
- 品牌文件不含密钥，可入库；每个贴牌客户一个文件便于 diff
