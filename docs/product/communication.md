# 站内信与私有通知

> **角色**：功能契约
> **适用对象**：站点管理员、前后端维护者
> **权威依据**：默认开关以 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs) 为准；端点与事务实现以 `src/Server/Communication/`、`src/Server/Identity/AdminInbox*.cs` 与 `src/Cli/Schema/03-community.sql` 为准。

## 1. 读者侧站内信与私有回放

- **功能与界面**：读者站内信页 `/user/messagebox` 运行于 FsusUI 账户任务工作区（`AccountWorkspace` `surface="task"`，使用 `ElInboxLayout` 与系列 Inbox 原语组件），涵盖支持工单与系统通知，按账号所有权严格隔离；内部注记绝不进入读者消息、未读计数、预览或通知。
- **读写与幂等契约**：
  - 沿用 `/api/binary/messages/conversations` 系列读取/写入路径与对应 AEDS 帧；读者写入受 `FSUSBLOG_PRIVATE_INBOX_WRITES` 控制（**默认开启**，可显式设 `false` 关闭）。
  - 创建工单与回复强制要求 `X-Fsus-Client-Mutation-Id` 及 Classic PoW（挑战入口 `/api/v2/notifications/inbox/pow-create.aeds` 与 `/{id}/pow-reply.aeds`），证明绑定会话、来源、命令键、操作、会话 ID 与原始请求字节，在写入同一 PostgreSQL 事务中消费一次。
  - 已读游标仅允许在当前账号可见会话内单调前进；相同命令键与输入可幂等重试，参数变化返回冲突。
- **事件回放与 WebSocket 实时唤醒**：
  - 每个账号的私有事件序号从 1 连续递增；`GET /api/v2/notifications/private.aeds` 搭配 `X-Fsus-Inbox-Replay-Cursor`（绑定签发会话）提供 `no-store` 增量回放，检测缺口时要求重拉列表同步。
  - `GET /api/v2/notifications/inbox/wake` 接受同源、带有效读者会话 Cookie 的 WebSocket（子协议 `fsus-inbox-wake.v2`，实例最多 32 条连接、无排队），由 PostgreSQL `NOTIFY` 驱动下发固定唤醒帧触发客户端回放，连接断开按退避重连并在会话撤销后立即关闭。
- **离线系统通知**：运维可通过 `FsusBlog.V2.Cli notify ACCOUNT_ID EVENT_ID`（stdin 传入 `{"subject":"…","body":"…"}`）向指定启用读者账号按 `(ACCOUNT_ID, EVENT_ID)` 幂等投递系统通知。

## 2. 管理端工单队列与协作能力

所有管理端站内信能力均在配置合法管理员源后**默认自动开启**（可逐项显式设为 `false` 静默关闭，或设 `FSUSBLOG_ADMIN_ORIGIN=""` 关闭全部管理入口）；所需表结构随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化；鉴权采用统一管理员会话与 `X-Fsus-Admin-Permission-Session`（已移除旧 `admin.manage` 子权限拆分）：

| 能力 | 覆盖环境变量（默认开启） | 核心契约与安全边界 |
| --- | --- | --- |
| 管理员回复工单 | `FSUSBLOG_ADMIN_INBOX_REPLIES` | `POST /api/v2/admin/identity/inbox/{id}/reply.aeds`（AEDS `60→58`），需当前管理员会话与 Classic PoW；已关闭工单拒绝回复；不改动读者已读位置 |
| 工单状态流转 | `FSUSBLOG_ADMIN_INBOX_STATUS` | AEDS `61→211`，校验行版本 CAS 与 1–256 码元变更原因（进行中/待处理/关闭/重开），需 Classic PoW；同状态重试返回 `NoChange` |
| 内部注记 | `FSUSBLOG_ADMIN_INBOX_NOTICE` | 仅管理端可见；同时支持管理端向指定启用读者 UUID 发送单账号系统通知（AEDS `32942→203`，`X-Fsus-Source-Event-Id` 全局唯一幂等，需 Classic PoW） |
| 共享未读水位 | `FSUSBLOG_ADMIN_INBOX_SHARED_READ` | AEDS `32949/32950` 与确认帧 `201`，多管理员共享单调前进的非内部读者消息已读游标，不影响读者侧已读状态 |
| 实时唤醒 | `FSUSBLOG_ADMIN_INBOX_LIVE` | `/api/v2/admin/identity/inbox/{id}/wake` 及队列唤醒复用 `fsus-inbox-wake.v2`（共享最多 4 条连接、无排队），提醒重读当前快照并保留草稿与焦点 |
| 活动时间排序 | `FSUSBLOG_ADMIN_INBOX_ACTIVITY_ORDER` | 队列可切换按最后非内部消息时间与会话 ID 倒序，首屏绑定已提交消息上界保证跨页一致 |

## 3. 验证入口

```bash
# 隔离 PostgreSQL、Kestrel 与真实浏览器桌面/窄屏断线补读回归
bash tests/EndToEnd/run-inbox-native.sh

# 启用 Caddy HTTPS 复验（需指定 CADDY_BIN）
FSUSBLOG_TEST_INBOX_TLS=1 bash tests/EndToEnd/run-inbox-native.sh

# 管理端工单回复、状态、共享已读与实时唤醒 HTTPS 回归
bash tests/EndToEnd/run-admin-tls.sh
```

当前明确未包含的范围：外部邮件/Web Push 投递、全站广播与管理员逐事件历史回放。
