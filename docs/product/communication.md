# 站内信与私有通知

v1 账号侧的站内信包括支持工单和系统通知，由账号所有权限制。管理端队列、管理员身份、内部注记、广播与通知 WebSocket 有各自的权限和协议。此阶段接入账号会话列表、会话详情、向前或向后读取消息、精确标记已读，沿用 `/api/binary/messages/conversations` 系列路径和当前的 AEDS 帧。服务使用当前 v2 会话锁保护身份、有效期和撤销代次。

账号写入按账号和原始命令键幂等。相同键和相同输入返回原结果，内容、会话或已读参数变更返回冲突。已读目标须属于当前会话并且对账号可见，游标不可倒退。读取列表的游标保存消息快照上界、消息时间和会话 ID。查询当前账号的未读、系统、待处理、进行中和已关闭会话，详情可按消息 ID 取相邻页。用户只能看自己的会话，内部注记不会进入账号的消息、未读计数、预览或通知。

PostgreSQL 事务同时提交消息、可见活动位置、已读状态和通知。每个账号的事件序号从 1 开始且连续。重连可以从已应用的序号继续分页，检测到缺失或超前游标时要求重同步。事件保存会话和消息坐标，由授权后的视图重新读取内容。服务启动只验证这些表的结构，数据库创建由离线迁移工具负责。

站内信页面 `/user/messagebox` 使用本地 FsusUI 的任务标题、筛选、空态、载入状态和操作控件。桌面显示会话列表和阅读区，窄屏在两者切换，返回时恢复原选项焦点。页面支持筛选、加载更早记录、标记已读和私有通知刷新。

v2 私有回放入口是 `GET /api/v2/notifications/private.aeds`。首张会话列表给出与数据读取一致的 `X-Fsus-Inbox-Replay-Cursor`，后续请求用 `after` 传递该值。游标只在签发它的登录会话有效。每个回放请求重新检查账号状态、会话有效期和代次。事件缺口要求重新读取列表取得新游标，浏览器仅在数据读取成功后推进游标。回放不缓存，当前保留所有事件，尚未定义自动清理窗口。该入口补充账号侧回放，v1 的公开和管理员 WebSocket 协议仍待迁移。

工单创建、回复及系统通知写入已实现服务端存储。v1 工单创建和回复需要 PoW，HTTP 路由和页面操作待接入 v2 的实际证明校验后启用。通知 WebSocket 握手、公开和管理事件、广播、管理队列、会话状态变更、历史迁移和自动生产者仍待接入。

协议测试使用 v1 固定列表和消息样本，以及独立构造的当前详情、请求和回放帧。三项原生 PostgreSQL 18 测试通过，覆盖并发重试、请求冲突、跨账号隔离、内部注记、已读校验、列表分页、回滚、断线续读、事件缺口、会话撤销和错误帧。`FSUSBLOG_TEST_DB` 指向允许创建临时数据库的 PostgreSQL。浏览器脚本 `tests/EndToEnd/run-inbox-native.sh` 使用各自的临时数据库和实际 Kestrel，配置见脚本。

参考：[固定提交的站内信 HTTP 路由](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Messages.cs)、[通知握手约束](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/architecture/notification-stream-handshake-use-case-boundaries.md)。
