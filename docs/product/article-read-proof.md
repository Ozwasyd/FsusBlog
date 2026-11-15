# 公开文章阅读统计

阅读统计默认关闭。启用前离线运行 `article read-proof-schema`，配置正式的 `FSUSBLOG_PUBLIC_ORIGIN` HTTPS 地址，再设置 `FSUSBLOG_ARTICLE_READ_PROOF=true`。站点通过当前配置的公开入口提供阅读统计。服务仍可在统计表缺失、临时会话不可用或统计事务失败时提供公开文章。 [固定 v1 契约和设计依据](../issues/risk-human-read.md)

浏览器只在实际正文处于视口且标签页处于前台后请求挑战。收到响应后开始累计正文可见时长。累计可见与服务端实际经过时间均至少达到 8 秒，才可计数。切换文章、替换发布版本或离开页面会取消当前观察。协议使用专用 POST，浏览器省略凭据；普通 HTML、AEDS 详情与 HEAD 请求不触发统计。

| POST 端点 | AEDS 请求 | AEDS 响应 |
| --- | --- | --- |
| `/api/v2/public/articles/{id}/{publication}/read/challenge.aeds` | 32976，空负载 | 32977，4B 小端可见时长下限和 56B 不透明票据 |
| `/api/v2/public/articles/{id}/{publication}/read/submit.aeds` | 32978，4B 小端可见时长和同一 56B 票据 | 32979，1B 提交结果，`1` 表示聚合提交已确认，`0` 表示本次未被计数 |

入口要求准确的 `Origin` 和同源 Fetch Metadata。临时票据绑定用途、文章和当前发布坐标，最多有效 5 分钟，跨 UTC 15 分钟窗无效。提交在事务中重新核对实际当前发布，撤回或改版后的旧票不计数。同一文章、浏览器上下文和短窗内最多计一次。公开热门列表使用独立开关，只展示当前公开文章的聚合次数。 [热门列表](public-hot-articles.md)

## 统计事务与恢复

统计使用独立的非池化 PostgreSQL 物理会话，数据库入口需保持固定会话。临时表保存本窗的用途隔离摘要，每窗最多接受 8,192 次。每次提交把消费、文章 UTC 小时计数、文章 UTC 日停留分档与单一窗水位纳入同一受保护事务。分档为 `<10s`、`10–<30s`、`30–<120s`、`≥120s`。票据、浏览器地址、UA、路由和单次停留时长不进入持久表或 outbox。计数不读取旧浏览量种子。

运行库具有总数索引时，文章已验证阅读总数也随同一事务更新。总数到达 `2,147,483,647` 后保持封顶，原小时聚合继续计量。停服运行 `article read-proof-schema` 可从小时聚合安装或重算派生总数，原统计和旧种子保持原值。备份应使用匹配的程序版本。若曾用旧程序写入该库，恢复当前版本公开热门前停服重算。

连接丢失或写租约交接后，旧会话签名世代作废。新会话在当前窗已有计数时拒绝另发挑战，时间推进到新窗才恢复。没有计数的新数据库可以在本窗启动。收到提交应答前断线时，统计不做补写，数据库可能已保留聚合。计划升主遵循站点停写、旧主库隔离和 WAL 回放验证；灾难升主的聚合恢复点取决于实际回放。 [数据库租约与物理备库](../publication-lease.md)

## 部署隐私边界

让统计会话的 `log_parameter_max_length` 和 `log_parameter_max_length_on_error` 都等于 `0`。若启用了 `pgaudit` 或 `auto_explain`，同时禁止它们输出绑定参数。应用拒绝向不满足这些条件的会话写入摘要。运行环境应排除该入口的请求体和鉴权头转储、原始地址记录、主机核心转储和原始数据盘或内存快照。临时表可在 PostgreSQL 主机产生临时文件，常规 `pg_dump` 与 `pg_basebackup` 不备份临时数据。对持久介质有更严格要求的部署须验证易失表空间和主机转储设置。 [PostgreSQL 参数日志](https://www.postgresql.org/docs/18/runtime-config-logging.html#GUC-LOG-PARAMETER-MAX-LENGTH) · [物理备份排除](https://www.postgresql.org/docs/18/protocol-replication.html)

由 `FSUSBLOG_TEST_ARTICLE_READ_PROOF=1 tests/EndToEnd/run-admin-tls.sh` 运行独立 PostgreSQL、Caddy 和 Chromium 用例。测试使用环回 TLS 和临时数据库。保留期与长期站点容量需要单独验收，当前聚合不会自动清除历史小时或日记录。

2026-11-15 的 PostgreSQL 18.7、Caddy 2.11.9 与 Chrome 157 用例通过。正文离屏 8 秒没有发起请求，滚入视口后只累计一次小时与短停留档。普通 HTML 和 AEDS 详情热读分别观察到零数据库命令、零物理连接。重放、旧发布和撤回均无新增。实际 `pg_dump` 包含聚合表，省略活动临时表。另有 4 个 .NET 验收通过，其中故障用例截断 PostgreSQL 的 COMMIT 应答，独立连接仍读回单次聚合。新统计会话拒绝在占用窗内启用旧票。 [浏览器验收](../../tests/EndToEnd/article-read-proof-flow.mjs) · [事务故障验收](../../tests/Integration/ArticleReadAuthorityPostgresTests.cs)
