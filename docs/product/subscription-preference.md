# 站点订阅偏好

公开文章仍由 RSS、Atom 和 JSON Feed 分发。订阅偏好默认关闭。运营方在配置正式的 `FSUSBLOG_PUBLIC_ORIGIN` HTTPS 地址并安全设置 `FSUSBLOG_SUBSCRIPTION_HMAC_KEY` 后，才会启用同一来源的 `/subscribe` 和写入端点。密钥为独立生成的 32 个随机字节，以 64 位小写十六进制配置。保留同一密钥供服务重启、受控操作员和备份恢复使用。更换密钥会改变邮箱查找坐标，当前没有重新绑定迁移。

新库包含所需结构。旧库可在停服务时运行离线工具的 `site-subscription schema`。开启此功能时，服务会校验表结构和约束。关闭后，已保存的偏好仍在 PostgreSQL 内，公开页面与接口停用。

`POST /api/v2/subscription/enroll.aeds` 和 `POST /api/v2/subscription/cancel.aeds` 接收 AEDS 32890 的邮箱和 `rss` 或 `email` 渠道。首次登记固定该地址的渠道。现有记录、重复登记和已停用记录均返回空成功帧。邮箱采用 ASCII 地址验证，去除两端空格及统一大小写后，以站点密钥计算用途隔离的 HMAC-SHA256。数据库保存哈希、渠道、启停状态和时间。表单及请求不保留邮箱、凭据或会话，邮箱和凭据不放入链接或者可索引页面。

受控数据库操作员通过 `site-subscription issue-cancel rss|email` 签发退订凭据。用标准输入传入一行邮箱，标准输出接收一枚有效期 15 分钟的 64 字符凭据。每个启用偏好只接受最近一次签发的凭据。凭据为独立 256 位随机值，数据库只保存其摘要和期限。操作员应通过自己的已验证身份渠道交付该凭据。当前没有公开签发端点、邮箱验证、SMTP、外部邮件或 Web Push 投递。

取消请求在 `X-Fsus-Subscription-Proof` 提交凭据。匹配邮箱哈希、渠道和有效凭据的取消，会在同一个事务内停用偏好并清除凭据。包括过期、重复、错配和无记录在内的格式合法请求统一返回空成功帧。缺失或格式非法的凭据返回统一的请求错误。端点按来源 IP 限流，页面和接口响应均采用 `no-store`。取消后停用记录继续保留，匿名请求无法恢复或更改其渠道。

`FSUSBLOG_TEST_SUBSCRIPTION_PREFERENCE=1 bash tests/EndToEnd/run-admin-tls.sh` 使用 Caddy HTTPS 与隔离 PostgreSQL 验证三种 Feed、两个登记渠道、离线签发、统一退订回执和私密字段处理。脚本为本轮生成独立 HMAC 密钥，使用合成邮箱。

v1 使用匿名 `/api/binary/subscriptions`，首次保存和后续匿名写入均可设置渠道或重新启用，退订使用绑定到邮箱哈希和渠道的限时一次性凭据。v2 保留登记和退订偏好，采用原生 v2 AEDS 布局、独立哈希域、数据库原子消费、统一合法格式回执和停用保留策略。 [v1 订阅路由](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Subscriptions.cs) · [v1 订阅与投递边界](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/security.md)
