# 单机数据库租约与交接

FsusBlog Server 使用独立的非连接池 PostgreSQL 会话持有数据库独占 advisory lock。`FSUSBLOG_DB` 指向一个 PostgreSQL 主库，使用直连或能固定后台会话的连接方式。应用启动时会验证数据库结构与锁持有者。正在持有锁的服务会阻止第二个服务进入就绪状态。

服务每 250 毫秒核对锁所在的数据库、后台 PID、后台启动时间和锁类型。锁确认最长有效一秒，从查询开始计时。应用按单调时钟检查这个期限，公开热读仍直接使用内存快照。失联、所有权不匹配或超过期限后，旧进程停止接受请求和后台投影任务。就绪探针和原公开入口返回 `503`，旧进程须重新启动。已经传出的响应字节无法撤回。

文章写入、会话命令等受保护的事务先持有共享交接锁，再核对独立数据库会话仍拥有主锁。另一进程取得主锁后需要通过排他的交接锁，并等待上一读期限满，再生成自己的快照和开放 HTTP 监听。已经发送给数据库的提交可能成功，客户端此时可能收到 `503` 或断线。文章命令可用原幂等键查询结果或安全重试。共享交接锁覆盖应用受保护事务，外部 SQL 操作者应遵循停机交接。

正常交接先从代理摘除旧进程并提交优雅停止，确认旧进程退出，再启动新进程和检查 `/health/ready`。同一 PostgreSQL 主库上的独占准入和交接锁用于单机部署，跨数据库或主库切换仍需独立仲裁。

数据库锁身份来自 PostgreSQL 的 `pg_locks`。独立会话使用 Npgsql 的有限命令与取消等待来发现连接故障。[PostgreSQL 锁视图](https://www.postgresql.org/docs/18/view-pg-locks.html) · [Npgsql 连接参数](https://www.npgsql.org/doc/connection-string-parameters.html#timeouts-and-keepalive)

## PostgreSQL 物理备库演练

部署前可使用独立发布包和两套本地 PostgreSQL 18 数据目录验证手动升主。测试只建立私有 Unix socket，由两个实际的 Kestrel 进程分别连接主库和升主后的数据库。数据库备份使用 `pg_basebackup`，再由 `pg_verifybackup` 独立检查。 [PostgreSQL 物理备库](https://www.postgresql.org/docs/18/warm-standby.html) · [备份命令](https://www.postgresql.org/docs/18/app-pgbasebackup.html)

```bash
tests/Integration/Migration/physical-standby.sh RELEASE_DIRECTORY NEW_EVIDENCE_DIRECTORY
```

`32880a1` 的真实发布包完成此演练。尚在恢复模式的备库拒绝应用启动。实际发布成功后，备库追到该事务已落盘的 WAL 坐标 `0/301D380`。停止并确认原主库退出、原应用就绪探针返回 `503` 后，备库升为时间线 2。新 Kestrel 从同一公开代次恢复文章，并用原命令字节重放。撤回只产生一条新修订及事件，HTML、AEDS 和旧索引代次随后拒绝。原应用保持运行以证明读写均已拒绝，测试结束后两套数据库和应用均已清理。 [过程证据](../artifacts/native-physical-standby-32880a1/run.log) · [HTTP 结果](../artifacts/native-physical-standby-32880a1/http-result.json)

演练只覆盖停写且已达到回放坐标的计划切换。灾难场景的恢复点取决于实际回放进度。生产操作仍需由外部仲裁隔离原主库，并单独验证私有媒体和其他节点事实。

## 管理域部署状态

独立管理域的 `system.config` 管理员可手动读取 `GET /api/v2/admin/identity/operations/cluster.aeds`，返回 v2 AEDS 32962。结果记录此进程实例 ID、程序集版本、启动时间、读取时间、当前 PostgreSQL 主库租约证明的年龄及公开快照就绪状态。年龄使用相同单调时钟，从绑定当前确认的探针发起时计量。响应禁用缓存并绑定发起读取的管理会话。租约丢失时旧实例的请求走 `503`，接替实例重新生成身份。可用 `FSUSBLOG_NODE_ID` 配置节点标签，最长 64 个 ASCII 字母、数字、点、连字符或下划线。省略时无需公开机器名或进程号。

此入口的模式固定为单机，界面明确显示分布式调度不可用。v1 实际集群入口使用 `/api/binary/author/ops/cluster/nodes` 的 AEDS 235 负载，其成员目录、调度、远端资源、分布式任务和控制仍待交付。 [v1 固定入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/ClusterMembershipEndpoints.cs#L21)
