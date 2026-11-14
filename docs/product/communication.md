# 站内信与私有通知

v1 账号侧的站内信包括支持工单和系统通知，由账号所有权限制。管理端队列、管理员身份、内部注记、广播与通知 WebSocket 有各自的权限和协议。此阶段接入账号会话列表、会话详情、向前或向后读取消息、精确标记已读，沿用 `/api/binary/messages/conversations` 系列路径和当前的 AEDS 帧。服务使用当前 v2 会话锁保护身份、有效期和撤销代次。

账号写入按账号和原始命令键幂等。相同键和相同输入返回原结果，内容、会话或已读参数变更返回冲突。已读目标须属于当前会话并且对账号可见，游标不可倒退。读取列表的游标保存消息快照上界、消息时间和会话 ID。查询当前账号的未读、系统、待处理、进行中和已关闭会话，详情可按消息 ID 取相邻页。用户只能看自己的会话，内部注记不会进入账号的消息、未读计数、预览或通知。

PostgreSQL 事务同时提交消息、可见活动位置、已读状态和通知。每个账号的事件序号从 1 开始且连续。重连可以从已应用的序号继续分页，检测到缺失或超前游标时要求重同步。事件保存会话和消息坐标，由授权后的视图重新读取内容。服务启动只验证这些表的结构，数据库创建由离线迁移工具负责。

站内信页面 `/user/messagebox` 使用本地 FsusUI 的任务标题、筛选、空态、载入状态和操作控件。桌面显示会话列表和阅读区，窄屏在两者切换，返回时恢复原选项焦点。页面支持筛选、加载更早记录、标记已读和私有通知刷新。

v2 私有回放入口是 `GET /api/v2/notifications/private.aeds`。首张会话列表给出与数据读取一致的 `X-Fsus-Inbox-Replay-Cursor`，后续请求用 `after` 传递该值。游标只在签发它的登录会话有效。每个回放请求重新检查账号状态、会话有效期和代次。页面的列表、详情、回放、已读和写入请求均携带当前登录会话标识。当 Cookie 在另一标签页切换时，服务会拒绝旧页面的请求并要求重新确认身份。事件缺口要求重新读取列表取得新游标，浏览器仅在数据读取成功后推进游标。回放不缓存，当前保留所有事件，尚未定义自动清理窗口。

`/api/v2/notifications/inbox/wake` 接受同源、带当前站点 Cookie 的 WebSocket，子协议为 `fsus-inbox-wake.v2`。HTTPS 流量走交付的 Caddy 路由。明文只用于直连回环开发。服务最多同时接受 32 条连接，无等待队列。消息事务通过 PostgreSQL `NOTIFY` 唤醒服务的共享监听连接。每条连接重新验证原会话和所属账号的位置，只发送固定 AEDS 成功帧。客户端收到唤醒后调用私有回放。连接中断后按退避重连，打开新连接即检查未应用事件。连接可用时仍周期性检查回放，连接不可用时改用短周期 HTTP 回放。服务定期复核账号状态、会话有效期和代次，撤销后关闭连接。 [PostgreSQL LISTEN](https://www.postgresql.org/docs/18/sql-listen.html) · [ASP.NET Core WebSockets](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/websockets?view=aspnetcore-10.0)

受控运维进程可使用离线工具 `notify ACCOUNT_ID EVENT_ID` 给一个启用账号发系统通知。命令从标准输入读取 UTF-8 JSON 对象 `{"subject":"…","body":"…"}`，用配置中的数据库身份完成当前结构校验和写入。`ACCOUNT_ID` 是明确给出的 v2 账号 UUID，`EVENT_ID` 在该收件人范围内用于幂等。重复提交相同通知返回原会话和消息坐标，修改内容后重用事件键会失败。命令输出坐标和是否重放，正文由账号会话授权读取。

设置 `FSUSBLOG_PRIVATE_INBOX_WRITES=true` 可开放账号提交工单和回复。部署前应确定实际处理工单的运维流程。现有 v1 创建和回复路径保留 AEDS 请求及响应帧，并要求 `X-Fsus-Client-Mutation-Id`。客户端先向 `/api/v2/notifications/inbox/pow-create.aeds` 或 `/api/v2/notifications/inbox/{id}/pow-reply.aeds` 提交原始请求取得 v2 随机挑战，再通过浏览器 Worker 完成 Classic PoW。证明绑定当前会话、来源、命令键、操作、会话编号和原始请求字节，在写入消息的同一事务中消费，失败后可用新的证明和原命令键重试。v1 自适应风险规则和 PoW 策略仍待迁移。

独立管理员站点 `/admin/identity` 提供只读工单队列。管理员须通过自己的 Passkey 登录，并持有固定 v1 管理接口使用的 `admin.manage`。服务在每次读取时检查当前会话、权限、撤销代次和租约。v2 队列按会话创建编号倒序分页，可筛选进行中、待处理和已关闭；详情按消息编号分页。游标绑定管理员当前会话及筛选或会话编号。管理详情显示原账号消息和内部注记，账号视图仍排除内部注记。打开队列、读取详情或返回列表不会更改账号已读位置。

2026-11-15 使用独立 Caddy TLS 站点、原生 PostgreSQL 和 Chrome 验证管理员登录、队列筛选、桌面和窄屏键盘操作及焦点恢复。账号 API 不返回内部注记，公开站点拒绝管理员队列路径。另用 PostgreSQL 验证分页、游标隔离、已读位置不变和撤销会话。证据位于 `artifacts/admin-inbox-native/`。

v1 的共享管理员未读投影、管理回复和状态修改、公开及管理员事件、握手 PoW 与签发授权、广播、历史迁移和自动生产者仍待接入。

协议测试使用 v1 固定列表、工单请求和消息样本，以及独立构造的当前详情和回放帧。五项原生 PostgreSQL 18 测试覆盖默认关闭、证明缺失、跨账号和跨会话拒绝、一次性消费、换证明幂等重试、并发写入、请求冲突、内部注记、已读校验、列表分页、回滚、断线续读、事件缺口、会话撤销和错误帧。WebSocket 测试实际拒绝跨源与匿名连接，检查只有目标账号的已提交事件产生唤醒，并验证撤销后返回策略关闭。`FSUSBLOG_TEST_DB` 指向允许创建临时数据库的 PostgreSQL。浏览器通过 `bash tests/EndToEnd/run-inbox-native.sh` 使用临时数据库和实际 Kestrel，验证桌面及 375px 页面在断开后获取期间提交的消息。设 `FSUSBLOG_TEST_INBOX_TLS=1` 并指定 `CADDY_BIN` 可用交付配置和独立证书复验 HTTPS。

界面按 FsusUI 消费契约归为 `bounded-composition`，验收范围为 `ux-path`。采用固定 v1 的 `Messages.vue`、会话列表和详情源码定位产品结构，参考的明暗截图只有列表工具栏裁切。组件契约绑定 FsusUI `f2d929a5d045439c35e93b4771f912ce50ec2337`。页面覆盖登录隔离、桌面及窄屏、头部筛选、会话阅读、回放、已读状态及焦点。启用账号写入时显示工单和回复表单，输入和重试键会随登录账号变更清空。产品行的状态文字直接展示来源和未读数量。完整账户外壳仍待接入。

2026-11-14 23:27 用本机 Chrome 在桌面日间主题 1280×800 和窄屏夜间主题 375×850 复验。匿名看不到列表，登录后可以用键盘阅读详情，`notify` 新消息无需刷新即可出现。页面标记已读后，SQL 确认两个会话保存了实际的已读位置。窄屏返回时焦点回到原会话按钮。两种尺寸均通过浏览器 Worker 完成真实 PoW，SQL 确认每个账号写入一条工单和一条回复。协议和数据库日志、部署文件摘要、截图及清理状态在 `artifacts/inbox-pow-native/`，临时数据库已删除。浏览器验收仍需覆盖所有筛选组合、网络恢复和更多浏览器。

参考：[固定提交的站内信 HTTP 路由](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Messages.cs)、[通知握手约束](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/architecture/notification-stream-handshake-use-case-boundaries.md)。
