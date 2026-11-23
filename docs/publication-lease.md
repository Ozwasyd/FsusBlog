# 单机数据库租约与交接

> **角色**：架构与运维契约
> **适用对象**：站点部署者与后端维护者
> **权威依据**：租约实现以 `src/Server/InstanceLease.cs` 为准，集群诊断接口以 `src/Server/Identity/AdminClusterEndpoints.cs` 为准。

## 1. 独占租约与故障闭合

- `FsusBlog.V2.Server` 使用独立的非连接池 PostgreSQL 会话持有数据库独占 advisory lock。`FSUSBLOG_DB` 必须指向 PostgreSQL 主库，并使用直连或可固定后台会话的连接方式。
- 应用启动时核验数据库结构与锁所有权；当前持有租约的实例会阻止第二个服务实例进入就绪状态。
- 服务每 250 毫秒核对锁所在数据库、后台 PID、后台启动时间与锁类型；每次确认最长有效 1 秒（单调时钟）。公开热读在租约有效期内直接消费内存 `PublicSnapshot`，不触发数据库查询。
- 一旦失联、所有权不匹配或超过 1 秒期限，旧进程立即停止接受请求与后台投影任务，`/health/ready` 与公开入口 fail-closed 返回 `503`，须重启恢复（已经发出的响应字节无法撤回）。

## 2. 写入交接锁与优雅切换

- 文章写入、会话命令等受保护事务先持有共享交接锁，再复核独立会话仍持有主租约锁。
- 接替进程取得主租约锁后须先获取排他交接锁并等待上一读期限排空，再构建公开快照与开放 HTTP 监听。交接窗口中已发送至数据库的提交可能成功，客户端收到 `503` 或断线时可凭原幂等键安全重试。
- 正常停机切换流程：先从反代摘除旧实例 → 发送优雅停止信号并确认旧进程完全退出 → 启动新实例并检查 `/health/ready`。外部 SQL 维护应遵循停机交接。

## 3. PostgreSQL 物理备库切换演练

仓库提供本地隔离物理备库升主与原主库回卷（`pg_rewind`）演练脚本（使用私有 Unix socket、`pg_basebackup`、`pg_verifybackup` 与两个真实 Kestrel 进程）：

```bash
# 演练备库升主与旧实例 503 隔离
tests/Integration/Migration/physical-standby.sh RELEASE_DIRECTORY NEW_EVIDENCE_DIRECTORY

# 追加 --rejoin 复验原主库 WAL 分叉、pg_rewind 回卷与流复制入组
tests/Integration/Migration/physical-standby.sh RELEASE_DIRECTORY NEW_EVIDENCE_DIRECTORY --rejoin
```

- 处于恢复模式的备库拒绝应用启动；计划切换要求先停写并确认备库追平已落盘 WAL 坐标，再由外部仲裁隔离原主库并升主。灾难场景的数据恢复点取决于实际回放进度；生产环境还须单独核验私有媒体与其他节点外部状态。

## 4. 管理端部署状态诊断

管理员在 `/admin/site` 底部「服务与版本」区域读取 `GET /api/v2/admin/identity/operations/cluster.aeds`（AEDS `32962`，`no-store`，绑定管理员会话），展示进程实例 ID、程序集版本、启动时间、读取时间、单调时钟租约证明年龄与公开快照就绪状态（租约丢失返回 `503`）。可通过 `FSUSBLOG_NODE_ID` 设置最多 64 位 ASCII 节点标识（字母、数字、`.`、`-`、`_`），未配置时不暴露主机名或 PID。当前底层部署模式固定为单机独占租约。
