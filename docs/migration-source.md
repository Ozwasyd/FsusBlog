# v1 → v2 离线数据迁移依据

参考提交为 FsusBlog `2605b438eed8f16d12ddddf033d08a6fa18fcd12`。本文件基于该提交的静态源码和运维文档。实际部署的数据库结构、行数、对象存储、密钥与源数据的状态待在授权的只读环境中查验。下文的映射是离线转换设计。首条链路的 v2 数据库只能用于新站点和验收数据，生产 v1 导入仍待实现并通过恢复演练。

## 冻结点与只读盘点

1. 确认源实例、站点、实际 v1 部署代码、数据库提供方和版本、迁移历史以及所有持久化存储。对 PostgreSQL 源库使用专用只读身份及只读、可重复读的事务，获取准确表名、列型、键和行数。使用 catalog 中的实际限定名，处理 SqlSugar 显式映射和大小写差异。对其他提供方分别核验结构及时间、布尔、排序语义，直至对应源适配器通过实库测试前保持阻塞。
2. 区分持久化权威数据、可重建投影、处于等待或已投递的事件，以及应在切换时废止的短期安全状态。每组记录来源、计数、边界值、无法关联或分类的行数、适用转换规则和阻塞原因。行摘要按确定的主键排序，按明确类型、空值、编码和时区规则序列化。敏感数据的摘要与映射随受控备份保存，仓库仅保留脱敏计数和检查结果。
3. 预演可以使用现有备份。正式切换前冻结所有写入方，包括 v1 的应用、后台任务、对象存储写入和其他节点。如果切换期间仍允许写入，需要已实现、已验证的增量摄取和重放。现有转换设计要求冻结修改请求直到切换确认。冻结后建立最终快照，保存数据库及迁移历史、相关 Redis 权威状态、上传文件、受保护的 Data Protection key ring、配置和外部密钥引用。独立恢复副本后校验该快照及各外部对象间的一致性。
4. 在已恢复的副本上生成确定性计划。绑定源 schema 及快照、备份摘要、目标 schema、转换版本、每段行数、身份映射、数据缺口和处置决策。向独立空目标应用，checkpoint 与数据变更在同一目标事务提交。重试复用同一计划、来源和映射。完成后由单独的只读核验检查数据、投影、权限和运行证据。

来源：[v1 数据库迁移手册](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/database-migration.md)、[存储备份与恢复手册](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/releases/release-storage-backup-and-restore.md)、[备份信封与恢复演练](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/security/site-backup-envelope.md)。

### 可执行的源库预检

使用 `dotnet run --no-build --project src/Migrate -- legacy inventory postgres` 读取 PostgreSQL catalog，并统计文章、分类标签、发布权利和责任数据的十二个固定投影。连接串通过 `FSUSBLOG_V1_DB` 注入，非 public schema 另外设置 `FSUSBLOG_V1_SCHEMA`。独立 SQLite 备份以 `legacy inventory sqlite` 读取，文件来自 `FSUSBLOG_V1_SQLITE_PATH`，要求没有未合并的 WAL 或 rollback journal。MySQL 支持同名子命令和 `FSUSBLOG_V1_DB`，要求选定表在 InnoDB 中。连接使用专用只读账号，SQLite 以只读模式打开。

把 `inventory` 换为 `plan` 会检查稳定 ID、当前编辑和发布指针、发布序号、权利和责任快照坐标、分类和 URL 别名引用、不可变正文块的 UTF-8 字节数和 SHA-256，并输出固定列投影摘要。正文块哈希接受 v1 历史大小写差异，权利快照保留字段原样，包括已知的历史待重算标记。摘要绑定提供方读取到的值，报告不包含业务行原文。每表扫描上限 500,000 行，单文本字段上限 2 MB，每条查询和总体快照分别限定 30 秒和 4 分钟。超出、缺列和引用不一致均阻塞。报告保留 v1 激活条件和 `readyToApply: false`，`plan` 的退出码 2 表示已生成预检报告且仍需实施或解决阻塞。

SDK 10.0.404 下，PostgreSQL 18.7、SQLite 和 MySQL 8.4.13 使用符合 v1 旧字段形状的隔离样本，通过了行数、稳定摘要、Unicode 正文、错误哈希、错配发布坐标及缺列测试。MySQL 也拒绝了转为 MyISAM 的表。预检尚未核对外部附件、备份摘要身份、完整权限和主体现实映射。

测试入口为 [legacy-source.sh](../tests/Integration/Migration/legacy-source.sh)，接受 `sqlite`、`postgres` 或 `mysql`。MySQL 分支使用 `MYSQL_TOOLS_DIR` 或 PATH 中的原生 MySQL 8.4 工具。在独立的临时数据目录启动无 TCP 监听的实例，以仅有 SELECT 权限的账号验证预检，结束时关闭和清理实例。2026-11-14 22:14 实跑退出码为 0，基准提交、工作树文件摘要及原始输出在本地 `artifacts/native-migration/mysql-20261114T141427.log`。

### 文章影子转换演练

`dotnet run --no-build --project src/Migrate -- legacy rehearse postgres owner-map.json` 在同一个只读源快照中重跑计划，再写入仅供此次演练使用的 SQLite 内存库。另两种源可用 `mysql` 或 `sqlite`。现有 v2 数据库连接串不参与此命令。预检报告的 `audit.projections` 提供 `article` 投影的 SHA-256，`sourceAdminIdentitySha256` 绑定源库管理员 ID 和 handle。由持有完整站点权限证据的操作者在受控目录提供映射文件。

```json
{
  "sourceArticleSha256": "<article projection SHA-256 from plan>",
  "sourceAdminIdentitySha256": "<administrator identity SHA-256 from plan>",
  "owners": [
    {
      "articleId": 42,
      "legacyAdminId": 7,
      "v2UserId": "968ffb2b-77ef-4868-89ec-6a0a19b28b95"
    }
  ]
}
```

每篇文章需有唯一归属，管理员 ID 和 v2 用户 UUID 一一对应。演练核对管理员存在及两份源摘要，拒绝把修订作者当成文章所有者。影子库保留 int32 文章标识、int64 v1 修订和发布标识、各文章内的修订号与发布号、未发布正文、当前发布指针和历史发布。公开候选修订由 v1 发布和删除状态约束，最终按计划时间与权利规则另行验证。写入后回读核对行数、归属、修订和发布坐标，并输出影子表摘要。报告不含正文，演练结束后内存库释放。影子转换限定每张投影 5,000 行及 128 MB 文本。

演练成功返回 0，报告仍明确保留 `readyToApply: false` 和未覆盖条款。管理员映射只证明影子归属引用可解析，实际权限、账号合并或 Passkey 的 int32 账户标识和用户句柄、凭据及会话迁移需要各自验收。完整迁移还需保全发布权利和责任快照、分类标签、媒体、待处理工作、草稿及附属关联。

第二版演练把分类 ID、标签 ID、活动文章关联和 URL 别名原样写入严格类型影子表，并将每条历史修订的标签列表转换为独立的修订关联。分类 0 表示无分类，旧关联已丢失的标签、重复关联和规范名冲突都需要显式映射。发布权利策略、不可变权利与责任快照通过发布 ID、修订 ID 和修订号绑定。责任首版可以引用同篇文章另一修订的快照，后续版本必须引用同修订的上一版。回读检查快照字段与原投影一致，以及正文当前草稿与历史发布仍有各自的引用。

演练覆盖字段类型、关系和保留原值。签名、权利规范摘要的重算和透明日志链验证仍待独立实现。有历史待重算标记的快照不会获得真实性证明。仍需核验来源站点注册、部署 schema 与备份证据。源提供方通过演练时只确认其输入兼容性，生产激活仍被阻塞。

2026-11-14 22:47 使用 .NET SDK 10.0.404 在 SQLite、PostgreSQL 18.7 和 MySQL 8.4.13 的隔离旧字段样本通过第二版演练。三个提供方重复演练摘要一致，拒绝过期身份映射、别名冲突、重复历史标签、错修订快照、未知哈希格式和非法责任前驱。临时库和实例已清理，运行基准、工作树输入摘要与原始输出在本地 `artifacts/native-migration/release-shadow-20261114T144640.log`。

### 导入隔离的 PostgreSQL 候选库

`legacy import` 将通过影子演练的记录写入一次性 PostgreSQL 候选库。目标由独立的 `FSUSBLOG_IMPORT_DB` 指定，须为本机 Unix socket，库名以 `fsusv2_import_` 开头。先用当前 v2 CLI 建立空库并单独预置映射需要的作者身份；导入从不创建或修改授权。目标只允许这些账号和当前结构标记。按[离线备份流程](migration.md)生成目标的导入前备份并独立保管清单 SHA-256。

```bash
dotnet run --no-build --project src/Migrate -- legacy import plan sqlite \
  "$owner_map" "$verified_backup_dir" "$manifest_sha256" > "$plan"
dotnet run --no-build --project src/Migrate -- legacy import apply sqlite \
  "$owner_map" "$verified_backup_dir" "$manifest_sha256" "$plan"
```

计划绑定全部支持的源投影、所有者映射、源管理员摘要、目标标识、结构和备份。应用重新对照这些内容，取得 PostgreSQL 独占写者锁，写入禁止启动的结构标记，再分三个事务保存文章谱系、分类标签、权利责任。各事务在记录检查点前独立回读行数和摘要。中断后用原始计划重跑，工具逐段重新验证现有数据并续跑；改过的计划、源数据、目标数据、备份或阶段都被拒绝。恢复需在另一个独立空库运行原备份的 `pg_restore` 和回读检查。候选保留在 `fsus_legacy_candidate` 中，现有公开业务表不接收导入数据。

候选仍返回 `readyToApply: false`。附件、旧角色或凭据、额外字段和未注册持久表会阻塞暂存，报告逐类列出确测行数。当前作者权限与旧角色含义、签名和权利摘要重算、定时发布解释和生产激活皆需独立实现及验收。本文的候选流程不能作为现有业务库的升级工具。

2026-11-15 00:17 用 .NET SDK 10.0.404 验证了 SQLite 源到原生 PostgreSQL 18.7 候选的实写、禁止启动、模拟阶段中断续跑、检查点数据变更拒绝和原备份隔离恢复；三种源的只读影子演练也重新通过。独立确认临时库和目录已清理。脱离工作树的构建基准、输入摘要和原始结果见本地 `artifacts/native-migration/import-20261114T161718.log`。MySQL 和 PostgreSQL 源从只读盘点和内存影子可用，完整导入端到端跑的是 SQLite 源样本。

只读 PostgreSQL 结构盘点示例。表级计数与哈希在已确认候选集合内逐表运行，表名来自 catalog 并按提供方规则引用。预估行数可协助安排盘点，完成验收时应保存精确行数。

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT current_database(), current_setting('server_version'),
       current_setting('transaction_read_only');

SELECT n.nspname AS schema_name, c.relname, c.relkind
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp_%'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
ORDER BY n.nspname, c.relname;

SELECT table_schema, table_name, ordinal_position, column_name,
       udt_schema, udt_name, is_nullable, is_identity, column_default
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name, ordinal_position;

ROLLBACK;
```

## 数据映射与校验

### 身份、认证与权限

- `sys_user` 的 int 账号 ID 和 `admin_principal` 的 long 管理员 ID 属于两个独立命名空间。离线工具为每个 `(sourceSite, identityKind, sourceId)` 分配唯一 v2 UUID 并在计划中保存双向映射。切换重试沿用映射。保留公共 handle、opaque subject、创建与注销轨迹，后台账号的显示名和登录 handle 仍独立处理。文章、评论、会话、站内信、审计引用通过类型匹配的映射解析。
- `sys_user.status` 表示正常、受限或注销，`registration_state` 单独表示注册生命周期。读取 `ban_state_generation`、匿名凭证状态和风险标记。只有 v1 同样允许对应操作的身份可启用。被封禁、注销、停用或状态未知的身份保持拒绝。监测目标的代次递增和缓存失效。首链路 `blog_user.enabled` 只有单一布尔语义，完整映射需要保留历史状态及受限能力。
- `admin_principal` 的 `IsRoot`、`Permissions`、`Status` 和 `ValidationVersion` 参与管理授权。明确保存各项能力的 grant 与拒绝。v1 的 `article.write`、`article.publish` 及 `comment.moderate` 等各自授权。首链路的 `blog_user.can_author` 无法表达它们的组合。完整角色及站点权限尚未具备时，禁止把源身份接入生产。
- `passkey_credential`、`admin_passkey_credential` 分开保存归属、credential ID、COSE 公钥、用户 handle、计数、备份标记和凭证历史。必须同时核验 WebAuthn RP ID、origin 策略和 v2 验证器行为，确认同一身份可继续使用该凭证。无法建立兼容性时，采用有归属验证的重新注册，记录受影响身份和恢复路径。测试旧凭证在错误作用域或被撤销后被拒绝。
- `user_mfa_profile` 包含加密 TOTP、恢复码摘要及版本、最近使用时间步。管理员 TOTP 在 `admin_principal`。`account_recovery_key` 含使用及撤销状态。迁移必须核验受控解密与重新加密方案、摘要算法和单次使用约束，或在启动前落实恢复及重新登记。禁止重置验证计数、恢复已用凭证或把 MFA 用户降级为单因素。保留数据时按凭据存储要求处理密钥及密文。
- `sys_user_session`、`admin_session` 含空闲与绝对到期、撤销状态、认证强度、验证版本或会话模式。普通身份还包含 refresh lineage 和 `user_refresh_token_tombstone`。切换方案显式废止 v1 会话及未完成 challenge/enrollment，要求重新认证，保留合规审计。验证旧会话及其 refresh 均不可用。首链路的 `login_ticket`、`user_session` 属于新的凭证边界，每个实际映射应用都从空会话开始。
- 对匿名 credential root、epoch、issuance audit、撤销和 nullifier 盘点保存、轮换、废止依赖。用户重新认证只解决账号会话接续。匿名评论管理凭据、匿名关联和隐私承诺仍需验证。

来源：[v1 身份实体](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Entities/User.cs)、[管理员实体](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Entities/AdminPrincipal.cs)、[管理权限](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/Auth/AdminPermissions.cs)、[会话实体](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Entities/UserSession.cs)、[WebAuthn 配置](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs)。

### 正文、修订、发布与附件

- 保留 `article.id` 的 int 公共标识。复制到目标 identity 列需显式覆盖 identity 值，并在导入验收时验证后续自增不会碰撞。源 `article` 无强制 owner 列，`article_revision.created_by_admin_principal_id` 表示修订来源，其中 0 是未归属 sentinel。每篇文章的目标 `owner_id` 需要来源明确的权限映射或经确认的站点保管方案。映射缺失、越站点或扩大权限时拒绝导入。
- `article` 有摘要、封面、分类、标签关系、建立和更新时间、可见状态 `Draft` / `Scheduled` / `Published` / `Archived` / `Deleted`，以及发布或归档时间。当前 Markdown 来自 `article_body`，修订正文来自 `article_revision_content_block`，通过 `article_revision.content_block_id` 关联。按 `(article_id, revision_no)` 保存修订和时间，保留源修订 ID 的查找映射以解析回滚、责任和证明关系。校验正文块的 UTF-8 字节长度、SHA-256 和引用唯一性。源修订行的兼容字段 `markdown_content` 在回填后可为空。
- `article.current_revision_id` 指向当前修订，`current_publication_id` 指向独立发布记录。后者绑定 `article_revision_id`、发布序号和当前 rights / responsibility 快照。目标公开坐标应来自该记录指定的修订，同时核验源状态、删除标记和调度时间。测试有未发布新草稿的已发布文章、撤回、归档、软删除、计划发布和重新发布。首链路 `published_revision` 加当前 `article_publication` 只能容纳单个当前发布坐标。激活前必须补齐历史发布、分类标签、计划时间、权利快照、责任、签名与透明日志等具有业务价值的映射。
- `article_draft` 以后台主体及 draft key 为作用域，含文章与基准修订关联、正文、预览权利、客户端修订及服务端 CAS。保存独立草稿，保留未建文章的草稿。为 `article_mutation_command`、发布受理、待投递 outbox 和下游回执制定旧客户端处置。首链路 `article_command` 承接 v2 命令；v1 中的字符串幂等键和请求哈希还依赖旧请求语义，需保留原权威回执或显式切换协议。确认等待事件只被已知消费者处理一次，再以目标发布坐标重建公开 HTML、AEDS、搜索、分类与标签投影。
- `content_asset` 的 UUID、public/private storage class、storage key、状态和对象字节受业务约束。核验 `content_asset_reference` 中来源组合及引用计数、工作稿和修订内的正文引用、封面、权限及孤立对象。复制对象到独立目标位置，确认每个存在对象的长度、哈希、权限和可解析性。对遗留哈希 NULL 的对象计算实测摘要，保留来源缺口。清理队列与隔离对象需逐项识别，避免在导入过程中误删。

来源：[v1 文章数据模型](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Entities/Article.cs)、[修订正文块的迁移定义](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/migration/Definitions/ArticleRevisionContentBlockMigrationDefinitions.cs)、[文章幂等记录模型](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Entities/ArticleMutationCommand.cs)、[媒体及引用模型](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Entities/ContentAssetEntities.cs)。

### 首链路结构之外的持久数据

| 范围 | 已确认的源表或存储 | 待实现与验证 |
| --- | --- | --- |
| 分类、标签、页面、评论 | `Category`、`Tag`、`article_tag`、`tag_url_alias`、`page_content`、`comment`、`comment_revision`、`comment_report`、`comment_moderation_event`、评论策略及 outbox | 保留公开路径、别名、评论树的 parent / root / reply 和匿名模式，核验只公开已允许内容。保留 Pending / Approved / Rejected / Hidden、删除与申诉历史。 |
| 站内信与通知 | `msg_conversation`、`msg_message`、`msg_participant_state`、`msg_admin_queue_state`、`msg_conversation_status_event`、`message_mutation_outbox`、Redis 通知 backlog | 保留会话参与者、发送者类型、内部注记、内容脱敏和读取游标。受控排空或对账等待事件；保留可证明的通知顺序，无法沿用的旧 cursor 显式要求重同步。 |
| 创作与属性 | `article_draft`、`author_saved_view_*`、`author_article_pin_*`、`authoring_canvas_*`、`article_property_definition*`、`article_template_*`、浏览器本地工作区 | 保留身份、站点、稳定字段及选项 ID、schema revision、用户值、Canvas 节点/边与文章关联、操作历史。浏览器本地草稿和工作区另行导出或在切换前同步，逐项确认未同步风险。 |
| 插件、主题、字体、导出 | `plugin_registry`、`theme_registry`、`theme_config`、`theme_activation`、`theme_asset`、`theme_activation_history`、字体及本地扩展包目录、导出任务存储 | 核验包字节、签名、hash、当前启用主题、字体与引用、运行版本及权限。原授权仅在经过 v2 相同权限、信任和撤销验证后恢复。明确待执行任务的重试或取消逻辑。 |
| 运维、统计与安全审计 | `sys_systemConfig`、`sys_audit_log`、`admin_audit_log`、`article_read_hourly_aggregate`、`read_dwell_daily_aggregate`、调度和拓扑状态、源迁移历史、Data Protection key ring | 保留配置的生效语义、历史、统计时间窗和审计归属。验证密钥可用性和环境隔离。投影重建需要保存来源坐标。独立处理历史节点、租约和尚未完成的分布式义务。 |

来源：[v1 后端实体](https://github.com/Ozwasyd/FsusBlog/tree/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Entities)、[v1 数据库定义](https://github.com/Ozwasyd/FsusBlog/tree/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/migration/Definitions)、[通知重放存储](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/NotificationStream/NotificationStreamBacklogStore.cs)、[本地字体注册表](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/Fonts/LocalFontRegistry.cs)。

## 启用条件

每组权威数据需建立最终 schema、转换器、历史与外键映射、独立的数量和语义验证。任何未分类的源表、未知状态、孤立引用、权限扩大、未解决的会话或凭据、丢失的对象、留在旧系统的待投递事件都应成为明确的候选阻塞。备份中保留源数据是恢复前提，目标业务语义仍应通过核验。

正式切换前需以代表实际部署结构的数据在本机或指定外部 PostgreSQL 环境演练一次完整流程。至少覆盖导入中断与幂等重跑、私有与已撤回内容、管理员写入和发布的独立权限、旧会话废止、凭据恢复、附件引用、公开投影与同一发布坐标。记录备份及快照摘要、被废止的身份及数量、各组差异、核验开始结束时间与清理结果。当前没有真实 v1 库、可用的生产备份副本或已通过的 PostgreSQL 演练结果。

启用只允许通过独立验证的当前 schema 和恢复方案。已启用后的故障由前向修复或恢复经验证且与代码版本匹配的备份处理。启用后产生的新写入可能超出备份恢复点，需要记录 RPO、待对账数据和恢复审批。v1 恢复只能连接独立的 v1 备份恢复库。
