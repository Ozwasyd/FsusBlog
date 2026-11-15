# Passkey 登录与首次绑定

V2 的站点账号可以通过可发现的 Passkey 登录。现有 `/api/binary/auth/passkey/login/begin` 和 `/api/binary/auth/passkey/login/complete` 使用 v1 `2605b438eed8f16d12ddddf033d08a6fa18fcd12` 的 POST 路径与当前 AEDS 帧 64、67 和 18。完成响应返回正整数 `AccountId` 和 `anonymous_account`。普通会话使用浏览器会话 Cookie，服务端限八小时。启用持久策略后，登录页允许选择保持登录。 [站点账号保持登录](site-persistent-refresh.md) · [独立管理员身份](admin-identity.md) · [站点账号 Recovery Key](site-recovery-key.md)

在应用环境配置 `FSUSBLOG_PASSKEY_ORIGIN` 和 `FSUSBLOG_PASSKEY_RP_ID` 后启用。RP ID 使用来源的 DNS 主机名，来源包含实际端口。生产来源必须使用 HTTPS。仅接受直接配置的来源与请求地址，部署于 TLS 代理后时应先接入可信代理配置。开发验证使用 `FSUSBLOG_PASSKEY_ORIGIN=http://localhost:54822` 和 `FSUSBLOG_PASSKEY_RP_ID=localhost`。

原有运维 CLI 发放的一次性票据可在登录页点击 Create Passkey，用于首次绑定。绑定使用 V2 独立路径，消耗原票据，绑定到 5 分钟 HttpOnly cookie、固定 RP 和当前账号代次。完成绑定时增加账号代次，在同一事务删除既有会话和未使用票据。此后该账号的普通票据登录与首次绑定入口拒绝请求，必须单独完成 Passkey 签名才获得会话。首次绑定入口不替代 v1 的匿名注册、二次确认添加设备、恢复、删除或重命名凭据。若浏览器取消已经开始的绑定，运维人员需要为尚未绑定的账号重新发票据。

使用 FIDO2 .NET Library 4.0.1 验证来源、RP、签名、用户验证和计数器。数据库为每个账号保存随机的稳定 WebAuthn user handle。设备提示使用统一账号元数据，不提交内部账号名。登录在持有账号及凭据锁时复核有效状态，再提交计数器、备份状态和会话。挑战分别绑定用途、容量和期限，使用后消耗。站点验证在 Fido2 验签成功后复核已锁定的凭据计数。双零表示凭据不支持计数，正向递增正常。正计数回退至零按普通未获授权拒绝，既有会话、计数和最后使用时间保持原值。此检查涵盖站点登录及复用同一校验的账号操作。独立管理员使用自己的验证路径。v1 可配的会话撤销、计数异常审计和事件投影仍待实现。

账号安全页的 Passkeys 区域读取当前站点账号自己的凭据元数据。请求 `GET /api/v2/identity/passkeys.aeds` 携带浏览器当前的 `X-Fsus-Current-Session`，服务器在同一事务检查当前有效的 Passkey 会话和账号归属。响应为不缓存的 V2 AEDS 帧 32980，包含创建时间、最近一次通过签名验证的时间、备份资格、备份状态以及当前会话使用标记。备份状态表示认证器在最近一次成功验证时报告的值。响应省略凭据 ID、计数器、公钥、设备标识和账号 user handle。固定 v1 的帧 65 依赖正整数凭据行 ID，V2 目前使用独立路径与投影。

账号持有人还可在同一面板修改通行密钥名称。管理列表使用 AEDS 33055，为每项提供当前访问会话的专用引用、名称和修订号。引用随登录会话变化，旧的 32980 元数据列表保留原有字节。已有数据库停服运行迁移 `site-passkey-names` 后可使用管理列表，新库初始化时直接安装名称表。

重命名由 AEDS 33056 启动同源 WebAuthn 确认。服务端的一次性挑战绑定具体凭据、目标准确名称、期望修订、账号代次和当前会话。浏览器使用当前会话的通行密钥完成用户验证后才写入名称。名称去除首尾空白，限制为 64 个 UTF-16 单元，已更新的修订提示重载。管理列表与命令使用会话专用引用，WebAuthn 仪式仍使用标准凭据选择器。已知 v1 约束参考固定 [重命名端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs#L1978) 和 [名称保存](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Security/PasskeyService.cs#L1579)。

**Add Passkey** 用于在已登录账号中增加一个设备。浏览器先用当前会话使用的通行密钥完成用户验证，再在同一已配置的 RP 上创建新通行密钥。创建选项通过帧 63 将账号已有的凭据列为排除项。创建挑战仅供当前会话和账号代次使用，窗口为两分钟，使用后消耗。一个账号同时准入一个创建窗口，最多保留 16 项凭据。成功注册保留原设备、活跃会话和恢复状态，新凭据可用于下次登录。 [固定 v1 账号注册入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs#L1701)

迁移旧凭据应保留原 `AccountId`、32 字节 user handle、凭据 ID、公钥、签名计数和备份元数据，并验证 RP 一致。`passkey_subject.account_id` 可由离线迁移明确写入旧值。导入后必须同步 identity 序列以防碰撞。旧库映射脚本尚未实现。

实测环境为 .NET SDK 10.0.404、PostgreSQL 18、Chrome 157 及真实 Vite 生产构建。`tests/EndToEnd/passkey-flow.mjs` 通过 Chrome 的虚拟 CTAP2 认证器执行真实 WebAuthn 注册和断言，验证独立首次绑定、已签名登录、写作页、服务端注销和清除 cookie。`tests/Integration/PasskeyPostgresTests.cs` 检查错误浏览器绑定、票据重用和账号代次变更时的数据库拒绝，数据库记录确认没有意外的凭据或会话。实际实体认证器和受控生产 TLS 部署留待验收。
