# 站点账号 Recovery Key

配置站点 Passkey 依赖方后，可设置独立的 `FSUSBLOG_RECOVERY_KEY_PEPPER_HEX` 启用 Recovery Key。变量值是由可信操作员保存的 32 字节随机值，以 64 位十六进制表示。它须独立于 TOTP 加密密钥，并与数据库备份分开保管。缺少此份 pepper 或更换它会使此前签发的 Recovery Key 失效。

新库包含恢复存储。已有库先停止 v2 服务并备份，再运行 `recovery-key schema` 添加存储。命令核对原结构并检查服务器所有权。启用 Recovery Key 的服务器要求完整结构，启动时只作匹配验证。

使用 Passkey 登录后，可从账号安全页创建或替换 Recovery Key。服务器复核当前账号、会话代次和操作类型，并要求 Passkey 用户验证。密钥只展示一次。用于查找的选择器和完整的随机密钥使用独立 pepper 作 HMAC-SHA256。密钥验证另使用随机盐和 600,000 次 PBKDF2-SHA256。显示格式沿用 v1 的 `frk_` 格式，v2 只验证自己签发的密钥。 [固定版本的 v1 Recovery Key 源码](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Security/RecoveryKeyService.cs)

登录页的 Recovery Key 流程先完成同源工作量证明，再验证密钥。每个已知密钥有十分钟内最多八次失败的限制，HTTP 路由另设来源配额。验证后浏览器获得仅能请求 Passkey 重绑的 HttpOnly Cookie。恢复窗口从验证成功开始计十分钟。验证响应丢失时，可以重新输入 Recovery Key。重新验证会替换恢复凭据，未到期窗口仍使用原到期时间。待完成的恢复在该窗口内优先于密钥轮换，现有 Passkey 和普通会话在成功重绑前保持有效。

成功重绑会在同个事务中消费 Recovery Key、为同一个账号安装新 Passkey、撤销旧 Passkey 和普通会话，并推进账号代次。相同的完成提交可在恢复窗口内重试。用户随后重新登录，现有 TOTP 和 TOTP 恢复码继续适用。

HTTP 契约位于 `/api/v2/identity/recovery-key/`。操作、签发结果、状态和验证帧为 32900 至 32903，WebAuthn 继续使用已有的 Passkey AEDS 帧。恢复始终替换旧 Passkey 并撤销旧会话。v1 另有可选撤销策略与独立风险服务。 [固定版本的 v1 AEDS 契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/api/contracts.md#recovery-key-aeds-frames)
