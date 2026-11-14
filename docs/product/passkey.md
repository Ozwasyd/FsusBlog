# Passkey 登录与首次绑定

V2 的站点账号可以通过可发现的 Passkey 登录。现有 `/api/binary/auth/passkey/login/begin` 和 `/api/binary/auth/passkey/login/complete` 使用 v1 `2605b438eed8f16d12ddddf033d08a6fa18fcd12` 的 POST 路径与当前 AEDS 帧 64、67 和 18。完成响应返回正整数 `AccountId` 和 `anonymous_account`。普通会话使用浏览器会话 Cookie，服务端限八小时。启用持久策略后，登录页允许选择保持登录。 [站点账号保持登录](site-persistent-refresh.md) · [独立管理员身份](admin-identity.md) · [站点账号 Recovery Key](site-recovery-key.md)

在应用环境配置 `FSUSBLOG_PASSKEY_ORIGIN` 和 `FSUSBLOG_PASSKEY_RP_ID` 后启用。RP ID 使用来源的 DNS 主机名，来源包含实际端口。生产来源必须使用 HTTPS。仅接受直接配置的来源与请求地址，部署于 TLS 代理后时应先接入可信代理配置。开发验证使用 `FSUSBLOG_PASSKEY_ORIGIN=http://localhost:54822` 和 `FSUSBLOG_PASSKEY_RP_ID=localhost`。

原有运维 CLI 发放的一次性票据可在登录页点击 Create Passkey，用于首次绑定。绑定使用 V2 独立路径，消耗原票据，绑定到 5 分钟 HttpOnly cookie、固定 RP 和当前账号代次。完成绑定时增加账号代次，在同一事务删除既有会话和未使用票据。此后该账号的普通票据登录与首次绑定入口拒绝请求，必须单独完成 Passkey 签名才获得会话。首次绑定入口不替代 v1 的匿名注册、二次确认添加设备、恢复、删除或重命名凭据。若浏览器取消已经开始的绑定，运维人员需要为尚未绑定的账号重新发票据。

使用 FIDO2 .NET Library 4.0.1 验证来源、RP、签名、用户验证和计数器。数据库为每个账号保存随机的稳定 WebAuthn user handle。设备提示使用统一账号元数据，不提交内部账号名。登录在持有账号及凭据锁时复核有效状态，再提交计数器、备份状态和会话。两种挑战均有容量和时间上限，使用后消耗。计数异常按普通未获授权拒绝，v1 可配的异常处置、审计和凭据事件投影仍待实现。

迁移旧凭据应保留原 `AccountId`、32 字节 user handle、凭据 ID、公钥、签名计数和备份元数据，并验证 RP 一致。`passkey_subject.account_id` 可由离线迁移明确写入旧值。导入后必须同步 identity 序列以防碰撞。旧库映射脚本尚未实现。

实测环境为 .NET SDK 10.0.404、PostgreSQL 18、Chrome 157 及真实 Vite 生产构建。`tests/EndToEnd/passkey-flow.mjs` 通过 Chrome 的虚拟 CTAP2 认证器执行真实 WebAuthn 注册和断言，验证独立首次绑定、已签名登录、写作页、服务端注销和清除 cookie。`tests/Integration/PasskeyPostgresTests.cs` 检查错误浏览器绑定、票据重用和账号代次变更时的数据库拒绝，数据库记录确认没有意外的凭据或会话。实际实体认证器和受控生产 TLS 部署留待验收。
