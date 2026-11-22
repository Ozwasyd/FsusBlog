# 站内信与私有通知

v1 账号侧的站内信包括支持工单和系统通知，由账号所有权限制。管理端队列、管理员身份、内部注记、广播与通知 WebSocket 有各自的权限和协议。此阶段接入账号会话列表、会话详情、向前或向后读取消息、精确标记已读，沿用 `/api/binary/messages/conversations` 系列路径和当前的 AEDS 帧。服务使用当前 v2 会话锁保护身份、有效期和撤销代次。

账号写入按账号和原始命令键幂等。相同键和相同输入返回原结果，内容、会话或已读参数变更返回冲突。已读目标须属于当前会话并且对账号可见，游标不可倒退。读取列表的游标保存消息快照上界、消息时间和会话 ID。查询当前账号的未读、系统、待处理、进行中和已关闭会话，详情可按消息 ID 取相邻页。用户只能看自己的会话，内部注记不会进入账号的消息、未读计数、预览或通知。

PostgreSQL 事务同时提交消息、可见活动位置、已读状态和通知。每个账号的事件序号从 1 开始且连续。重连可以从已应用的序号继续分页，检测到缺失或超前游标时要求重同步。事件保存会话和消息坐标，由授权后的视图重新读取内容。服务启动只验证这些表的结构，数据库创建由离线迁移工具负责。

站内信页面 `/user/messagebox` 运行在账户工作区任务壳体（`AccountWorkspace` `surface="task"`）内，使用本地 FsusUI 的 `ElTaskPageHeader`、Inbox Primitives（`ElInboxLayout`、`ElConversationList`、`ElConversationListItem`、`ElThreadPanel`、`ElConversationContextBar`、`ElMessageTimeline`、`ElMessageBubble`、`ElReplyComposerShell`、`ElInboxEmptyState`、`ElEmptySelectionState`）与 `ElDialog` 工单弹窗。桌面显示定高分栏列表与固定头部/回复栏的阅读区，760px 及以下窄屏在两者切换，返回时恢复原选项焦点。页面支持筛选、刷新、加载更早记录、标记已读、提交工单与私有通知实时刷新。

v2 私有回放入口是 `GET /api/v2/notifications/private.aeds`。首张会话列表给出与数据读取一致的 `X-Fsus-Inbox-Replay-Cursor`，后续请求用 `after` 传递该值。游标只在签发它的登录会话有效。每个回放请求重新检查账号状态、会话有效期和代次。页面的列表、详情、回放、已读和写入请求均携带当前登录会话标识。当 Cookie 在另一标签页切换时，服务会拒绝旧页面的请求并要求重新确认身份。事件缺口要求重新读取列表取得新游标，浏览器仅在数据读取成功后推进游标。回放不缓存，当前保留所有事件，尚未定义自动清理窗口。

`/api/v2/notifications/inbox/wake` 接受同源、带当前站点 Cookie 的 WebSocket，子协议为 `fsus-inbox-wake.v2`。HTTPS 流量走交付的 Caddy 路由。明文只用于直连回环开发。服务最多同时接受 32 条连接，无等待队列。消息事务通过 PostgreSQL `NOTIFY` 唤醒服务的共享监听连接。每条连接重新验证原会话和所属账号的位置，只发送固定 AEDS 成功帧。客户端收到唤醒后调用私有回放。连接中断后按退避重连，打开新连接即检查未应用事件。连接可用时仍周期性检查回放，连接不可用时改用短周期 HTTP 回放。服务定期复核账号状态、会话有效期和代次，撤销后关闭连接。 [PostgreSQL LISTEN](https://www.postgresql.org/docs/18/sql-listen.html) · [ASP.NET Core WebSockets](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/websockets?view=aspnetcore-10.0)

受控运维进程可使用离线工具 `notify ACCOUNT_ID EVENT_ID` 给一个启用账号发系统通知。命令从标准输入读取 UTF-8 JSON 对象 `{"subject":"…","body":"…"}`，用配置中的数据库身份完成当前结构校验和写入。`ACCOUNT_ID` 是明确给出的 v2 账号 UUID，`EVENT_ID` 在该收件人范围内用于幂等。重复提交相同通知返回原会话和消息坐标，修改内容后重用事件键会失败。命令输出坐标和是否重放，正文由账号会话授权读取。

设置 `FSUSBLOG_PRIVATE_INBOX_WRITES=true` 可开放账号提交工单和回复。部署前应确定实际处理工单的运维流程。现有 v1 创建和回复路径保留 AEDS 请求及响应帧，并要求 `X-Fsus-Client-Mutation-Id`。客户端先向 `/api/v2/notifications/inbox/pow-create.aeds` 或 `/api/v2/notifications/inbox/{id}/pow-reply.aeds` 提交原始请求取得 v2 随机挑战，再通过浏览器 Worker 完成 Classic PoW。证明绑定当前会话、来源、命令键、操作、会话编号和原始请求字节，在写入消息的同一事务中消费，失败后可用新的证明和原命令键重试。v1 自适应风险规则和 PoW 策略仍待迁移。

独立管理员站点 `/admin/identity` 默认提供只读工单队列。管理员须通过自己的 Passkey 登录，并持有固定 v1 管理接口使用的 `admin.manage`。服务在每次读取时检查当前会话、权限、撤销代次和租约。v2 队列按会话创建编号倒序分页，可筛选进行中、待处理和已关闭；详情按消息编号分页。游标绑定管理员当前会话及筛选或会话编号。管理详情显示原账号消息和内部注记，账号视图仍排除内部注记。打开队列、读取详情或返回列表不会更改账号已读位置。

2026-11-15 使用独立 Caddy TLS 站点、原生 PostgreSQL 和 Chrome 验证管理员登录、队列筛选、桌面和窄屏键盘操作及焦点恢复。账号 API 不返回内部注记，公开站点拒绝管理员队列路径。另用 PostgreSQL 验证分页、游标隔离、已读位置不变和撤销会话。证据位于 `artifacts/admin-inbox-native/`。

设置 `FSUSBLOG_ADMIN_INBOX_LIVE=true` 后，管理员可以收到当前账号工单已提交变动的唤醒。管理员专用的 `/api/v2/admin/identity/inbox/{id}/wake` 复用现有 `InboxWake` 和 `fsus-inbox-wake.v2`。服务检查管理员来源、独立会话和 `admin.manage` 后，只发送固定 AEDS 成功帧。连接最多四条，无排队。浏览器打开或重连后读取当前工单详情，保留正在编辑的草稿和焦点。历史分页仍可继续读取，共享已读位置仍由打开工单或主动重新加载触发。默认关闭，无需数据库迁移。冻结 v1 将账号新回复和状态变化投递给管理端，管理端在投影缺失时补读当前工单。 [v1 投递](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/NotificationStream/MessageCenterService.DeliveryOutbox.cs#L55-L113) · [v1 补读](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/composables/useAdminMessageCenter.ts#L505-L539)

候选 `13bf4fc` 通过 PostgreSQL 18.7、Caddy 2.11.9 独立 HTTPS 来源及 Chrome 157 验收。启用实时流和共享已读时，验证了账号经 PoW 新建和回复、管理员首屏和打开的工单各自更新、工单断线重连补读，以及草稿、焦点和共享未读位置保留。错误来源、站点会话和客户端发给唤醒连接的消息被拒绝，管理员会话撤销后连接关闭。单独以默认关闭设置重跑，队列和工单唤醒均返回 404，普通查阅仍可用。两次运行均清理 PostgreSQL、服务和代理。 [实时验收](../../artifacts/admin-inbox-live-13bf4fc/live/admin-identity-result.json) · [默认关闭验收](../../artifacts/admin-inbox-live-13bf4fc/default/admin-identity-result.json) · [浏览器断言](../../tests/EndToEnd/admin-inbox-flow.mjs)

同一开关让按创建编号排序的「全部」「进行中」「待处理」「已关闭」首屏，在新工单、公开回复或状态变动后读回当前结果。队列唤醒核对实际首屏及分页边界，所以较小编号较晚提交时也能被发现。工单详情跟随账号或管理员回复与状态变动。两个入口共享四条连接上限，唤醒帧只提示重新读取对应的已授权快照。被关闭工单移除焦点控件时，焦点回到工单标题，回复草稿仍留在当前页面。启用共享未读时，新工单显示一条未读。未读筛选、系统筛选、活动排序、后续页和管理员逐事件历史回放仍待接入。 [v1 创建与管理员投递](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/NotificationStream/MessageCenterService.MessageCommand.cs#L125-L141)

独立管理员回复默认关闭。先停服执行 `admin-inbox-replies`，再设 `FSUSBLOG_ADMIN_INBOX_REPLIES=true`。回复需要同一管理员会话下的真实 Classic PoW，挑战绑定当前会话、来源、会话编号、命令键和完整请求字节。管理员使用 v1 固定回复请求帧 60 和响应帧 58，经 v2 专用管理员站点 `/api/v2/admin/identity/inbox/{id}/reply.aeds` 使用。已关闭会话拒绝新回复。账号的已读位置不变，回复可通过原有账号详情、回放和 WebSocket 唤醒读取。证明消费、回复、原管理员身份和不可逆会话摘要、幂等命令及账号事件共用一次 PostgreSQL 提交。网络失败可携带同一命令键重新申请证明。

2026-11-15 完成原生 PostgreSQL 工单回归和停服迁移复验。Chrome 经交付 Caddy TLS 验证管理员实际获取并完成挑战、发送后账号站点显示回复，以及默认关闭时隐藏录入。两次浏览器运行均清理临时资源。证据位于 `artifacts/admin-inbox-reply/`。

独立管理员状态修改默认关闭。先停服执行 `admin-inbox-status`，再设 `FSUSBLOG_ADMIN_INBOX_STATUS=true`。管理员会话详情返回 PostgreSQL 行版本，Classic PoW 绑定来源、当前管理员会话、工单编号、行版本和完整请求。状态请求和响应沿用 v1 固定帧 61、211。工单可在进行中与待处理之间切换，两种状态都可以关闭，已关闭工单只能重新打开。修改需要填写 1–256 个 UTF-16 码元的原因。重复提交当前状态返回 `NoChange`，无需追加审计或账号事件。已变动的历史版本不能覆盖当前状态。实际修改将独立管理员身份、不可逆会话摘要、变更原因、状态和账号刷新事件与证明消费一并提交。账号详情只更新状态，保留原消息和已读位置；列表中的更新时刻随状态变化，最后消息时间保持原值。

独立管理员可共享工单未读状态。停服执行 `admin-inbox-read` 后设置 `FSUSBLOG_ADMIN_INBOX_SHARED_READ=true`。打开最新详情时，浏览器提交同一管理员会话收到的最后一条非内部消息坐标。共享游标单调前进，历史分页不更新，失败可重试同一快照。未读数统计共享游标之后的非内部账号消息；系统通知和管理员回复不产生共享未读。旧工单没有管理员游标时，先按全部账号消息未读处理。账号的已读位置和通知不受影响。旧版 v2 管理客户端继续使用原帧，启用的前端使用 32949/32950 帧和 201 确认帧。

共享未读回归覆盖两名独立管理员、晚到消息、交错确认、历史分页、内部注记、会话撤销和账号不受影响。Chrome 经 Caddy TLS 验证了默认隐藏控件，以及中断后以同一快照重试、清除未读计数并按未读筛选。离线迁移可重跑，缺少同工单消息外键时拒绝继续。证据位于 `artifacts/admin-inbox-shared-read/`。

设置 `FSUSBLOG_ADMIN_INBOX_ACTIVITY_ORDER=true` 后，管理员队列可切换为按最后一条非内部消息时间和会话 ID 倒序。队列默认按会话创建编号倒序。活动游标绑定管理员会话、筛选、投影和首屏已提交消息上界。后续页沿用该上界，回复和新工单下次刷新才改变顺序。状态和共享未读筛选仍读取当前值。内部注记仍可在授权详情读取。启用后，在线投递与同版本的离线 `notify` 在分配消息编号前取得共享事务锁。首屏短暂取得独占锁以确认已提交上界，分页查询在释放后运行。部署时更新与该数据库写入同一收件箱的离线工具。

PostgreSQL 回归覆盖微秒级排序、同时间工单、乱序提交、首屏后新消息和内部注记。Chrome 经 Caddy TLS 验证了活动排序与共享未读同时可用，默认隐藏排序入口。[验证记录](../../artifacts/admin-inbox-activity/)

适应性 PoW、精确旧管理端路径、专用状态事件和管理员广播、其他公开及管理员事件、握手 PoW 与签发授权、历史迁移和自动生产者仍待接入。v2 账号沿用事件 12 刷新当前会话。

2026-11-15 在 PostgreSQL 18 验证状态权限、一次性证明、并发版本保护、同状态重试和原因隔离。独立管理员站点经 Caddy TLS 完成真实 Chrome 状态修改，已打开的账号详情收到通知后自行更新。默认配置隐藏状态控件。停服迁移可重复执行，并拒绝缺少约束的表。证据位于 `artifacts/admin-inbox-status/`。

独立管理员系统通知默认关闭。停服执行 `admin-inbox-notice` 后，设置 `FSUSBLOG_ADMIN_INBOX_NOTICE=true` 可向一个明确指定的 v2 账号 UUID 发送。管理员必须持有 `admin.manage` 并完成 Classic PoW。v2 请求帧 32942 携带当前账号 UUID，成功仍返回 v1 会话详情帧 203。请求的 `X-Fsus-Source-Event-Id` 是全局唯一正整数。同一管理员可在换会话后用相同内容重试；复用事件编号提交不同目标、内容或管理员身份会返回冲突。新通知在事务内锁定并核对启用账号，生成一条未读系统消息和两条账号事件，保留首次操作者与不可逆会话摘要。账号页仅显示通知内容，仍通过既有私有回放和 WebSocket 唤醒更新。冻结 v1 系统通知接口也只接受一个账号，广播、管理员事件及旧数字账号坐标仍待接入。

2026-11-15 通过 PostgreSQL 集成验证同一事件并发提交、换会话重试、账号隔离、禁用后拒绝新通知和审计持久化。Chrome 在 Caddy TLS 下通过 FsusUI 发送单账号通知，已打开的账号站点收到更新。默认配置隐藏通知录入。停服迁移支持重复验证，缺失约束时拒绝继续。证据位于 `artifacts/admin-inbox-notice/`。

协议测试使用 v1 固定列表、工单请求和消息样本，以及独立构造的当前详情和回放帧。五项原生 PostgreSQL 18 测试覆盖默认关闭、证明缺失、跨账号和跨会话拒绝、一次性消费、换证明幂等重试、并发写入、请求冲突、内部注记、已读校验、列表分页、回滚、断线续读、事件缺口、会话撤销和错误帧。WebSocket 测试实际拒绝跨源与匿名连接，检查只有目标账号的已提交事件产生唤醒，并验证撤销后返回策略关闭。`FSUSBLOG_TEST_DB` 指向允许创建临时数据库的 PostgreSQL。浏览器通过 `bash tests/EndToEnd/run-inbox-native.sh` 使用临时数据库和实际 Kestrel，验证桌面及 375px 页面在断开后获取期间提交的消息。设 `FSUSBLOG_TEST_INBOX_TLS=1` 并指定 `CADDY_BIN` 可用交付配置和独立证书复验 HTTPS。

界面按 FsusUI 消费契约归为 `bounded-composition`，验收范围为 `ux-path`。采用固定 v1 的 `Messages.vue`、会话列表和详情源码定位产品结构，参考的明暗截图只有列表工具栏裁切。组件契约绑定 FsusUI `f2d929a5d045439c35e93b4771f912ce50ec2337`。页面覆盖登录隔离、桌面及窄屏、头部筛选、会话阅读、回放、已读状态及焦点。启用账号写入时显示工单和回复表单，输入和重试键会随登录账号变更清空。产品行的状态文字直接展示来源和未读数量。完整账户外壳仍待接入。

2026-11-14 23:27 用本机 Chrome 在桌面日间主题 1280×800 和窄屏夜间主题 375×850 复验。匿名看不到列表，登录后可以用键盘阅读详情，`notify` 新消息无需刷新即可出现。页面标记已读后，SQL 确认两个会话保存了实际的已读位置。窄屏返回时焦点回到原会话按钮。两种尺寸均通过浏览器 Worker 完成真实 PoW，SQL 确认每个账号写入一条工单和一条回复。协议和数据库日志、部署文件摘要、截图及清理状态在 `artifacts/inbox-pow-native/`，临时数据库已删除。浏览器验收仍需覆盖所有筛选组合、网络恢复和更多浏览器。

参考：[固定提交的站内信 HTTP 路由](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Messages.cs)、[通知握手约束](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/architecture/notification-stream-handshake-use-case-boundaries.md)。
