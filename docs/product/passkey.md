# Passkey 登录、注册与凭据管理

> **角色**：功能契约
> **适用对象**：站点部署者、安全维护者
> **权威依据**：读者 Passkey 配置推导与默认开关见 [`PasskeyConfiguration.cs`](../../src/Server/Identity/PasskeyConfiguration.cs) 与 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs)。

## 1. 启用与单源自动推导

- 配置 `FSUSBLOG_PUBLIC_ORIGIN`（HTTPS）后，读者 Passkey 自动复用同一 Origin 与主机名作为 RP ID；也可通过 `FSUSBLOG_PASSKEY_ORIGIN` 与 `FSUSBLOG_PASSKEY_RP_ID` 显式覆盖（生产必须 HTTPS，显式提供不匹配 RP ID 启动即失败；显式设为 `""` 静默关闭读者 Passkey 并同步关闭读者自助注册与持久续期）。
- 统一单域名模式下，普通读者与管理员共用 `/login` Passkey 登录页，服务端按凭据归属表（`passkey_credential` vs `admin_passkey_credential`）自动分流签发隔离会话 Cookie（`fsus-v2-session` vs `__Host-FsusAdminSession`）。管理员身份规则见 [独立管理员身份](admin-identity.md)。

## 2. 登录、首枚绑定与自助注册

- **可发现 Passkey 登录**：`POST /api/binary/auth/passkey/login/begin` 与 `complete` 沿用 AEDS 帧 `64`、`67`、`18`；普通会话有效期上限 8 小时（支持勾选「Keep me signed in」建立持久刷新会话，见 [站点账号保持登录](site-persistent-refresh.md)）。
- **一次性运维票据仅用于首枚绑定**：旧票据直登入口固定返回 `401 / passkey_required`（不消费票据、不建会话）。由 `FsusBlog.V2.Cli operator NAME` / `ticket NAME` 签发的 10 分钟票据仅用于「设置首枚 Passkey」，已绑定 Passkey 的账号不可用票据重设。
- **读者自助注册（`/register`）**：启用站点 Passkey 后，`FSUSBLOG_READER_REGISTRATION` **默认自动开启**（可显式设为 `false` 关闭）。读者确认站点准则并完成独立 PoW 与浏览器绑定短期挑战后创建普通读者账号（`blog_user`）；注册本身不签发会话，不授予任何创作或管理权限，随后需自行使用 Passkey 登录。
- **WebAuthn 校验与防克隆计数**：采用 FIDO2 .NET Library 校验 Origin、RP ID、签名、用户验证（UV）与单调计数。锁定账号与凭据行复核状态后提交计数器与备份标记；双零表示认证器不支持计数，正计数回退或归零一律拒绝并保持原会话与计数不变。

## 3. 已登录凭据管理（`/user/identity/mfa`）

所需表结构均随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化；所有管理操作均需同源 `Origin` 与当前会话头 `X-Fsus-Current-Session`：

- **凭据清单**：`GET /api/v2/identity/passkeys.aeds`（AEDS `32980`，`no-store`）返回创建时间、最近验签时间、备份资格/状态与当前会话标记（省略凭据 ID、公钥、计数器与 user handle）；管理视图使用 AEDS `33055` 提供会话绑定的临时引用、名称与修订号。
- **重命名凭据**：通过 AEDS `33056` 触发当前会话 Passkey 的同源 WebAuthn 确认（绑定具体凭据、新名称 ≤ 64 UTF-16 码元、期望修订 CAS、账号代次与会话）。
- **添加第二设备（Add Passkey）**：先经当前会话 Passkey 验证，再在同一 RP 下创建新凭据（帧 `63` 排除已有凭据，2 分钟单窗口，每账号最多 16 枚凭据），保留原设备与活跃会话。
- **移除设备（Remove Passkey）**：非当前凭据可通过 AEDS `33057` 经当前会话 Passkey 确认移除，并在同事务撤销目标会话、持久刷新链与待完成 MFA 流程；移除当前或最后一枚凭据须在 Recovery Key 面板组合恢复密钥与当前 Passkey 确认（见 [站点账号 Recovery Key](site-recovery-key.md)）。

## 4. 验证入口

```bash
FSUSBLOG_TEST_FLOW=passkey bash tests/EndToEnd/run-native.sh
FSUSBLOG_TEST_FLOW=reader-registration bash tests/EndToEnd/run-native.sh
# 可附加 FSUSBLOG_TEST_PASSKEY_REMOVE=1 / FSUSBLOG_TEST_PASSKEY_REMOVE_CURRENT=1 / FSUSBLOG_TEST_PASSKEY_RENAME=1
```

已知上游界面跟进：Passkey 改名后当前设备徽标显示依赖 [FsusUI #1127](https://github.com/Ozwasyd/FsusUI/issues/1127)。
