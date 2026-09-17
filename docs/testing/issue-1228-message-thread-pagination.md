# Issue 1228 长会话消息分页验收

本地验收不依赖公网、生产数据或外部存储。PostgreSQL fixture 构造 1005 条可见消息、
internal note 与首屏后的并发新消息，验证：首屏严格 50 条；`beforeMessageId` 向前遍历；
边界无重复；账号端不返回 internal note；首屏后新增消息不混入历史页；V3 AEDS 往返保留
`previousCursor`、`hasOlder` 与 `readSnapshotMessageId`。

前端 Vitest 覆盖 GET 必须发送 `beforeMessageId` 并声明 `ConversationDetailV3`，以及历史页、
边界重复和 notification stream 新消息的稳定合并。账户和 admin 都消费同一分页 DTO；匿名
请求仍由现有账户 principal 门禁拒绝，登录账户只读取自己的参与会话，admin 仍要求
`AdminManage`。notification stream 协议本身不变，binary-only 链路不增加 JSON fallback。

风险集中在新 frame 的跨栈布局和分页边界。运行中可把
`Messages:ThreadPaginationEnabled` reload 为 `false`，使两类详情固定返回 503；这不会恢复
旧全量查询。回退后列表、写入与 notification stream 保持原有行为。
