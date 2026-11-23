# 站点订阅偏好

> **角色**：功能契约
> **适用对象**：站点部署者与运维人员
> **权威依据**：密钥解析与开关前提见 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs) 与 [`SubscriptionIdentity.cs`](../../src/Core/SubscriptionIdentity.cs)。

## 1. 启用前提与密钥边界

- 公开文章始终由 RSS、Atom 与 JSON Feed 分发（见 [公开分发](distribution.md)）。
- 订阅偏好登记与退订入口 `/subscribe` 需**显式同时配置** HTTPS `FSUSBLOG_PUBLIC_ORIGIN` 与 64 位小写十六进制独立密钥 `FSUSBLOG_SUBSCRIPTION_HMAC_KEY`（可用 `dotnet FsusBlog.V2.Cli.dll init-secrets` 生成），未配置密钥时默认关闭；所需表结构随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化。
- `FSUSBLOG_SUBSCRIPTION_HMAC_KEY` 决定邮箱查找坐标，部署重启与备份恢复须保留同一密钥（更换密钥将改变所有邮箱 HMAC 索引）。关闭功能后已保存偏好继续保留在数据库，公开页面与接口停止挂载。

## 2. 登记、离线退订凭据与隐私保护

- **登记与退订端点**：`POST /api/v2/subscription/enroll.aeds` 与 `POST /api/v2/subscription/cancel.aeds` 接收 AEDS `32890`（邮箱与 `rss` / `email` 渠道），按来源 IP 限流，页面与接口一律输出 `Cache-Control: no-store`。
- **邮箱不可逆存储**：ASCII 校验、去空白并统一小写后计算用途隔离的 HMAC-SHA256，数据库仅保存哈希、渠道、启停状态与时间戳，不留存明文邮箱、不进入 URL 或可索引页面。首次登记锁定渠道；重复、已有或已停用记录均返回统一 `EmptySuccess (240)`，避免枚举。
- **离线签发一次性退订证明**：运维通过 CLI 签发 15 分钟有效、64 字符的 256-bit 随机退订证明（stdin 输入单行邮箱，数据库仅存摘要与过期时间，每条启用记录仅认最新一枚）：
  ```bash
  printf '%s\n' 'reader@example.org' | dotnet FsusBlog.V2.Cli.dll site-subscription issue-cancel email
  ```
- **原子退订**：客户端在 `X-Fsus-Subscription-Proof` 请求头提交证明，匹配时在单事务内停用偏好并清除证明；格式合法但过期/错配/无记录的请求同样返回统一 `EmptySuccess`；取消后的记录保持停用，匿名请求不可重新激活。当前不包含公开邮件发送、SMTP 或 Web Push 投递。

## 3. 验证入口

```bash
FSUSBLOG_TEST_SUBSCRIPTION_PREFERENCE=1 bash tests/EndToEnd/run-admin-tls.sh
```
