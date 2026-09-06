# UZF USDT 自动查账

该服务复用原 `uzf` 项目的“集中监控 + HMAC 查询”思路，生产版改为读取 OKX
`/api/v5/asset/deposit-history` 充值历史，因此同时支持链上充值与 OKX 内部充值。

- OKX API Key 只需要“读取”权限，禁止授予交易和提现权限。
- 查询 API 默认仅监听 `127.0.0.1:6000`，不向公网开放。
- WzzScrm 按订单生成唯一的两位小数金额，到账后再校验订单创建时间和 OKX `depId`；
  同一笔充值流水只能被一个订单认领。
- 缓存只保留最近两小时，使用临时文件 + 原子替换，查询时不会读到半截 JSON。

生产配置复制到 `/etc/omnichat/uzf.json`，格式见 `config.json.example`。同一个
`query_api.secret` 需要填入管理后台 USDT 支付通道的“UZF 查询密钥”，查询地址填
`http://127.0.0.1:6000`。
