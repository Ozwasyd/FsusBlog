# 站点账号二次验证

站点账号在 `/user/identity/mfa` 管理 TOTP。该页面沿用 v1 的路径，并用当前 AEDS 帧 48–52、54 和 55 调用账号接口。首次绑定需要当前 Passkey 会话重新签名，服务端把时限为 5 分钟的一次性 `mfa_setup` 授权绑定到账号、会话和代次。浏览器在同一会话确认验证码后启用 TOTP，并获得 8 个一次性恢复码。页面只显示这一次，代码应立即存入可信的密码管理器。

已经启用 TOTP 的账号先完成 Passkey 签名，得到 v1 `AuthLoginFlow` 的 `mfa_required` 阶段。浏览器提供验证码或恢复码后才建立会话。挑战与浏览器的 HttpOnly cookie 绑定。数据库事务保护 TOTP 时间步、一次性恢复码和会话。恢复码含 128 位随机数据，库中保存摘要。单个账号连续失败五次后有五分钟冷却。启用与停用在同一个事务中推进账号代次、撤销所有旧会话凭据，并为当前浏览器签发保留原到期时间的新凭据。`mfa_setup`、`mfa_disable` 和 `mfa_recovery_regenerate` 各自使用独立的授权。

启用 TOTP 后可用当前验证码或尚未使用的恢复码重新生成恢复码。页面先完成 `mfa_recovery_regenerate` 的专用验证，再向 `POST /api/binary/auth/mfa/recovery/regenerate` 提交绑定当前账号、会话、代次和动作的五分钟一次性证明。服务在一个事务内消费证明、作废全部旧码并保存 10 个新码的摘要。AEDS 帧 49 只在这次成功响应返回新码，使用相同证明重试返回 428。会话和认证器保留，页面离开、切换身份或确认隐藏后不再显示明文。若成功响应丢失，仍可用认证器重新验证并再生成一组。 [v1 恢复码轮换](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs#L994-L1051)

运行时配置站点 Passkey 来源（自动推导自 `FSUSBLOG_PUBLIC_ORIGIN` 或由 `FSUSBLOG_PASSKEY_ORIGIN` / `FSUSBLOG_PASSKEY_RP_ID` 显式指定），并从独立密钥存储注入 64 位十六进制 `FSUSBLOG_TOTP_KEY_HEX`（可通过 `dotnet FsusBlog.V2.Cli.dll init-secrets` 生成）。TOTP seed 使用 AES-256-GCM 与账号关联数据加密，数据库备份和密钥须分别保管并成对演练恢复。配置缺少密钥时，已启用二次验证的账号无法仅凭 Passkey 登录。

所需表结构随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化。验证入口：`FSUSBLOG_TEST_FLOW=mfa bash tests/EndToEnd/run-native.sh` 与 `tests/Core/TotpTests.cs`（RFC 6238 SHA-1 标准向量）。
