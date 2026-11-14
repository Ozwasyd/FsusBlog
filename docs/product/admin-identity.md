# 独立管理员身份

管理员从 `/admin/identity` 注册和使用 Passkey。运行时配置 `FSUSBLOG_ADMIN_ORIGIN` 和 `FSUSBLOG_ADMIN_RP_ID`。管理员域名必须和公开站点 `FSUSBLOG_PUBLIC_ORIGIN` 及站点账号的 Passkey RP 区分。线上使用 HTTPS。原生验收在环回地址使用 `localhost` 作为管理端，并通过 `127.0.0.1` 访问站点。反向代理应为管理域名传递原始 Host，仅转发管理员页面、身份 AEDS API 和静态资源，应用也会拒绝在该域名访问公开站点及站点账号入口。

通过受控的数据库操作员运行 `admin-identity bootstrap HANDLE admin.manage`。命令建立独立主体，提交后输出一枚十分钟内有效的一次性引导密钥。浏览器在管理域完成要求用户验证的可发现 Passkey 注册，引导密钥和挑战随后失效。注册本身不签发会话。重新用 Passkey 登录后，当前浏览器获得独立的 HttpOnly、SameSite=Strict 凭据。线上使用 Secure 和 `__Host-` 前缀将凭据限定在管理主机，环回验收使用限路径的独立 Cookie。每个管理员只有一个两小时有效的会话，完成新的 Passkey 验证会原子地撤销旧会话。

`admin-identity rotate-passkey HANDLE` 撤销旧凭据和会话并签发替代引导密钥，`admin-identity revoke-all HANDLE` 撤销会话和未完成的引导或登录挑战，`admin-identity disable HANDLE` 禁用主体并移除凭据。使用数据库会话真实操作员身份 `session_user` 写入同事务的离线审计。会话查询每次复核管理员状态、代次、会话到期时间、凭据和 `admin.manage`。站点作者标志和站点 cookie 无法取得管理员身份。

新库通过 `plan` 和 `apply` 建立组件。已经具备其余当前组件的旧库应先停止 v2 进程、备份并运行 `admin-identity schema`。命令使用现有的数据库启动锁、实例所有权检查和交接锁，验证数据库结构及管理员组件版本 1。启动缺少该组件时拒绝接入请求。

认证接口位于 `/api/v2/admin/identity/`。WebAuthn 复用 AEDS 帧 63、64、66、67，管理员状态使用 v2 帧 32830。此切片只开放管理员引导、登录、当前会话查询与注销。v1 还有独立管理员会话列表、JWT 轮换、长时会话、敏感动作的独立验证与其他业务权限。现有内容接口继续使用各自的权限判断。 [v1 管理认证契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/api/contracts.md#independent-admin-principal-aeds-endpoints)
