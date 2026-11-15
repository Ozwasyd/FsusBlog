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

`legacy plan postgres` 的 `importAdmission` 在同一个只读快照使用 `legacy import plan/apply` 的来源校验，无需候选库连接、所有者文件或备份。报告列出阻塞类别、来源表或列和确测行数，以及已识别投影的行数与摘要。未通过基础目录、文章或管理员身份结构检查时，`classificationComplete` 为 false，具体原因见 `blockers`。`eligibleForCandidatePlanning` 只表示分类完成且现有导入器未发现来源阻塞。后续计划仍须核对已审核的归属映射、目标隔离和独立备份。未支持的数据继续阻塞，预检不会导出权限、凭据或会话值。

在 PostgreSQL 的 `legacy inventory` 和 `legacy plan` 中，`propertyInventory` 单列旧属性关系。固定 v1 定义权威中的基表使用同一只读快照记录行数及绑定目录的摘要。未识别的属性基表只计行，视图和其他无法核验的关系单列。报告保留原迁移阻塞，并省略字段值和标签。后续转换仍需审核定义、历史和所有权映射。 [固定 v1 定义结构](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/migration/Definitions/ArticlePropertyDefinitionAuthorityMigrationDefinitions.cs) · [实库取证](../artifacts/legacy-property-inventory-a649068/native-2/verification.log)

`legacy properties rehearse REVIEW.json REVIEW_SHA256` 从 `FSUSBLOG_V1_DB` 和 `FSUSBLOG_DB` 分别读取隔离的旧库和目标库。审核文件版本为 1，包含 `sourceOwner`、`sourceSite`、`sourceRevision`、`targetOwner`、`targetSite`、`targetSchemaRevision`，以及以 relation 为键、以上述十张冻结定义与审计表的 `postgreSqlSha256` 为值的 `sourceRelations`。目标作者须可用，属性 schema 须为空且预期版本为 0。命令保留稳定定义 ID，通过现有 V2 定义转换及还原校验，输出可复验的摘要。适用范围为经过审核的个人作用域、仅原始创建历史，以及无默认值或投影标志的文本、数值、布尔和日期定义。客户端、正文和未知表里的值仍需独立来源核验。报告保留审计真实性、属性值和旧来源退役的未决项。

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

新生成的 PostgreSQL 导入计划在同一只读、可重复读源事务封存数据库与 schema 身份，以及所选 schema 中关系、列、默认值、约束、索引和继承边的结构摘要。若当前源身份已有 `pg_control_system()` 执行权，`sourceSeal.provenance` 为 `cluster-and-catalog`，数据库摘要绑定集群系统标识。其他只读身份继续使用 `catalog-and-endpoint`，摘要绑定实际选中的数据库和 schema 目录标识以及配置的连接端点。后一种来源仍需要独立备份和实例证明，切换运行时的要求见启用条件。报告只写摘要和来源级别。应用在打开目标连接前拒绝已封存的来源或目录变化。

目标结构摘要与原计划匹配时，已有未封存的 PostgreSQL 计划仍可与原已隔离候选一同续跑或离线复验。新的 PostgreSQL 候选分阶段写入需要当前工具生成的封存计划。SQLite 和 MySQL 的计划格式继续沿用当前各自的来源核验。

`bash tests/Integration/Migration/legacy-import.sh postgres --source-backup` 在私有 PostgreSQL 演练中从导出的旧源快照生成真实 custom archive。工具把同一只读文件描述符交给 `pg_restore`，复查实际原库和恢复库的结构及数据读取摘要，并确认数据库身份不同。测量保留两份原生读取摘要。结构及数据比较只归一化 PostgreSQL 18 对固定 v1 保存视图计数约束和附件枚举约束的已知等价写法。恢复会压缩先前删除的列所留下的物理位置，目录摘要按各自数据库记录。随后用只读恢复库生成导入计划，核对其业务投影与原库一致，并验证原库不能替代计划中的恢复来源。输出关联已消费归档、候选计划、隔离投影和用于目标回退的 v2 备份。演练同时验证目标断点续跑及独立回退。原始 v1 加密包的身份认证和同一次数据库／非空媒体启用仍须按原始备份与恢复合约验收。

候选仍返回 `readyToApply: false`。默认报告逐类列出附件、旧角色或凭据、额外字段和未注册持久表的阻塞行数。符合下文条件的私有附件可随文章隔离暂存。当前作者权限与旧角色含义、签名和权利摘要重算、定时发布解释和生产激活皆需独立实现及验收。本文的候选流程不能作为现有业务库的升级工具。

旧站已安装 `20260904-post-author-saved-view` 且有记录时，PostgreSQL `legacy import plan/apply` 按固定 v1 形状核验八张表，保全旧管理员整数与站点范围、视图 UUID、默认与置顶状态、条件与操作数、排序和投影、回执、变更明细与幂等记录。源事务检查键、空值约束、默认引用归属、回执次序及幂等关系。每表最多 5,000 行，总文本预算 128 MB。计划报告行数、摘要和阻塞项。 [固定 v1 DDL](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/migration/Definitions/AuthorSavedViewMigrationDefinitions.cs) · [v1 持久化](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Authoring/PostgresAuthorSavedViewPersistence.cs)

第三阶段把完整行写入隔离 schema。UUID 和微秒时间使用可逆文本，整数和布尔使用有符号整数列。计划绑定各表源与影子摘要及数据库来源。续跑和离线 `legacy import verify` 逐表复核隔离记录。生产启用仍需验证旧管理员和新作者、站点身份、类型化操作数、依赖、排序及投影的等价性。隔离候选始终禁止启动。

保存视图源预检和隔离候选的 `project/verify` 从有序条件、原始操作数、排序、投影和分页大小独立重算 v1 查询摘要。同时重算视图的旧管理员和站点归属摘要、集合摘要及原回执约束的末次命令摘要。核验报告记录已核对的查询、归属与集合数量。v1 规则要求一个主排序字段，`article.id` 在旧合约里仅为次级排序标识。v2 保存视图按文章 ID 倒序执行类型化属性条件，不能直接启用旧查询。即使当前结果恰好同序，旧主排序字段仍可独立于文章 ID 变化。 [v1 查询契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Authoring/AuthorSavedViewContracts.cs) · [v1 摘要](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Authoring/AuthorSavedViewStore.cs)

固定 v1 完成 `taxonomy-projection` 出站边时维护三张 PostgreSQL 派生表。`category_public_article_count` 与 `tag_public_article_count` 分别以 `category_id`、`tag_id` 为整数主键，保存 `bigint` 计数和 `updated_at_utc`。`article_public_taxonomy_projection` 以整数 `article_id` 为主键，保存可空的整数 `category_id`、排序后的文本 `tag_ids` 及 `updated_at_utc`。固定 v1 按可见性选择文章，再读取该文章的当前分类与标签关系。 [固定 v1 DDL](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/migration/Definitions/SecurityAndProjectionMigrationDefinitions.cs#L1275-L1310) · [出站边](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/ArticleMutationSideEffects.cs#L502-L513) · [可见性与关系来源](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Taxonomy/TaxonomyCountProjectionService.cs#L133-L181)

`legacy plan postgres` 和 `legacy import plan/apply` 在现有只读快照中验证三表结构，重算双向文章关系和分类标签计数。仍存在的分类或标签可保留当前计数为零的旧行。对可见但无正数分类坐标的文章，固定 v1 的回填与增量计数规则不同，本核验要求另外对账。缺少部分派生表、主键或空值约束变化、关系或计数失配以及无效时间都会阻止暂存。诊断区分 PostgreSQL 三表全缺、已核验为空、已核验有行及不适用的来源提供方。 [原生校验](../src/Migrate/LegacyTaxonomyProjection.cs)

新导入计划只封存已核验派生表的行数与带原始时间的摘要，`apply` 重新核验相同来源。旧计划可继续按原字节复验缺表或仍为空的范围。派生行留在来源中，不写隔离候选或当前运行库。现有实库证据使用合成旧站输入，完整激活仍需经过审核的真实旧站来源和备份恢复验收。

PostgreSQL 旧源有 `article.views` 时，导入计划分别封存文章原计数和可选的 `article_view_seed` 摘要。候选第一阶段把原计数、可空的旧基线和原 UTC 播种时间写入 `fsus_legacy_candidate.shadow_article_view_history`，保留缺行与零值的区别。没有这些字段的源继续使用原计划和检查点。隔离表不参与在线浏览量、热门排行或真人阅读统计。 [保全规则](../src/Migrate/LegacyReadingHistory.cs)

2026-11-15，PostgreSQL 18.7 合成源通过旧计数保全、目录与行篡改拒绝、断开旧源的候选复验和备份恢复。同次 SQLite 旧格式导入也通过。 [本地运行记录](../artifacts/p5-read-history-media-native/attempt-1/timeline.txt)

`tests/Integration/Migration/legacy-import.sh [sqlite|postgres|mysql]` 对三种只读源执行相同的候选实写、禁用启动、检查点续跑、改动拒绝和导入前备份恢复。2026-11-15 用 SDK 10.0.404、SQLite 3.54.0、PostgreSQL 18.7 和 MySQL 8.4.13 原生实例通过。PostgreSQL 来源连接明确强制只读事务，MySQL 来源位于无网络监听的临时实例，使用只有 `SELECT` 权限的账号。独立确认测试结束后自建库、临时目录和 MySQL socket 已清理。脱离工作树的构建基准、输入摘要和原始结果见本地 `artifacts/native-migration/provider-import-20261114T162656.log`。

### 演练写入当前文章表

对已完成三阶段暂存的同一个隔离候选库，可用 `legacy import project` 演练写入当前 v2 文章表。提供原始导入计划、从 `legacy import apply` 结果独立保存的 `planSha256`，以及该候选的导入前空库备份目录和清单 SHA-256。`planSha256` 是计划内容的规范摘要。此阶段只使用已暂存的旧记录，当前结构或候选数据库身份改变后，需重新建立候选和执行原始暂存。

```bash
dotnet run --no-build --project src/Migrate -- legacy import project "$plan" "$plan_sha256" "$verified_backup_dir" "$manifest_sha256"
dotnet run --no-build --project src/Migrate -- legacy import verify "$plan" "$plan_sha256" "$verified_backup_dir" "$manifest_sha256"
```

事务重新核对所有暂存表和检查点，再按原对象标识写入文章、修订、分类标签、原公开发布及对应权利。当前标题、正文、分类、标签需与已记录的头修订一致。首发时间和最近发布分别核对，旧计划发布和未解析的生命周期转换拒绝投影。读取已暂存快照中的 `immediate-publish` 记录，独立重算旧内容和旧权利策略的规范 SHA-256，再核对 v2 权利字段格式。对能够证实坐标的后续即时发布，也会按旧普通更新路径以首发时间重算，实际发布行仍保留自己的时间。缺失、待重算或不匹配的摘要会令整笔事务停止。旧权利可空文本与年份写入当前合同的空串和零标记，原始字段、权利绑定标记和旧责任记录仍保留在暂存表。

当前 v2 发布历史每篇只写入一个已有发布边界，原始发布事件、时间、ID、权利和责任坐标完整保留在隔离暂存表。不会生成 v2 作者命令或 outbox 事件。根据所有原始发布及权利 ID 保留序列高水位。写入和序列调整同一个事务提交。成功后，重复 `project` 和只读 `verify` 均重测暂存和当前表、序列及空库备份覆盖，比较原收据。

公开回滚仅接受旧站普通作者路径中可证明的形状。结果是当前可见发布，使用一个新修订，来自同篇文章较早且已核验的即时发布，目标修订的正文、分类、标签、权利和责任须与来源匹配。验证原始操作者、回滚原因、修订与快照时间，按旧首发时间独立重算内容和权利摘要；v2 当前发布行保留回滚发生的实际时间与原标识。回滚来源与理由保留在暂存表，当前发布历史只写已有发布边界。摘要重新生成导致不同、回滚到非公开状态及非当前回滚仍不在这个切片。一般来源的定时发布会在执行时清除旧到期坐标，此流程不推断丢失字段。仍要求使用现有暂存入口支持的源关系，完整旧 outbox 与签名链另需处理。

整个候选仍保留禁止启动的结构标记。命令恒返回 `readyToApply: false`。动态项目中的定时执行、恢复、日志签名和透明链、原稿摘要与责任呈现均未转换到当前运行时。未发布权利、旧责任链和全部历史坐标仍可离线核对，生产激活仍须另行完成。

2026-11-15 用 SDK 10.0.404 与 SQLite 3.54.0 来源在原生 PostgreSQL 18.7 验证有两次真实格式旧发布的文章。测试确认原发布及权利标识、当前与已发布正文差异、标签和别名、只读回读与禁止启动。通过仅拒绝最后一张权利关联表写入的数据库角色验证事务回滚，再成功重跑。已暂存行或当前表发生改动会拒绝重跑；独立测试内容及权利摘要不符均不落表。其他提供方继续覆盖前置三阶段暂存与恢复。原始结果见 `artifacts/native-migration/project-final-20261114T172731.log`。

同日新增的普通旧站形状样本保留一次再发布、一次未发布修订及其后的公开回滚，复验原发布和权利标识、回滚坐标、继承责任以及两种时间的区别。错误回滚来源、回滚到草稿与错误回滚摘要均拒绝写入。SQLite 旧样本写入原生 PostgreSQL 18.7，候选保持禁止启动。原始结果见 `artifacts/native-migration/project-rollback-20261114T175946.log`。

### 保留首次定时发布的离线证据

已暂存的候选可在 `legacy import project` 和 `legacy import verify` 的参数末尾加相同的 `--evaluate-schedules-at UTC`。使用带 `Z` 的明确 UTC 时间。该时间是操作员的核对坐标，实际旧库冻结时间由外部流程记录。接受自创建即排期、仍处于初始修订、在核对时间尚未到期且从未发布的文章。要求文章、正文、修订与权利快照保留精确创建时间，并根据旧版规则用 `Scheduled`、原到期时间、冻结内容和版权策略分别重算两个 SHA-256。可证明的初始责任快照引用一并保留。

正文、修订和分类标签写入当前形状的未发布记录。原定时坐标、旧修订和快照 ID、到期时间、核对时间及两项旧摘要写入隔离的 `retained_initial_schedule`。原暂存及投影摘要绑定这些信息。候选保持禁用，活动定时表、命令、回执及 outbox 均为空。固定 v1 创建流程会写出站事件，并可能写旧客户端回执。任何此类尚未纳入转换的源表有记录时，现有暂存流程会拒绝。已到期、已执行、修改既有发布、旧动态回执的转换及重新批准执行仍待独立实现。

2026-11-15 使用 SQLite 3.54.0 旧结构样本、PostgreSQL 18.7 目标和 .NET SDK 10.0.404 跑通暂存、投影、重跑和不连接旧站的只读复验。测试拒绝错误摘要、相等或更改的核对时间、修改后的到期坐标和同名约束替换，旧样本文件保持原样。见 `artifacts/native-migration/legacy-schedule-projection-20261114T190232Z.log`。

### 保全旧建文幂等回执

`legacy import plan` 会在 PostgreSQL 旧源按固定结构读取非空的 `article_mutation_command`，最多 5,000 条。计划版本 2 绑定源表和候选表的精确行数和摘要。`apply` 在第三个检查点写入 `fsus_legacy_candidate.shadow_article_mutation_command`，保留旧管理员整数 ID、客户端 UUID 字符串、原请求 SHA-256、首次修订和权利快照、发布坐标以及原 UTC 创建时间。原始 v1 请求字节不在回执中，因此只保存摘要和验证格式。首次发布须和对应的历史发布精确匹配。创建时未发布的记录保留 `0/0` 发布坐标。先前发布或创作后续修订不会改写该回执。

重跑重新读取旧源并核对原计划。`legacy import project` 或 `verify` 会复验候选回执数量和摘要，保留其隔离状态。新站运行用的 `article_command`、定时发布回执和 `blog_outbox` 不读取这些记录。旧授权证明和原请求不能从回执重建，不匹配首次版本或权利谱系的回执阻止暂存。新版 v1 `article_create_request` / `article_create_receipt` 属于独立的创作权威，含记录时仍会阻止暂存。SQLite 与 MySQL 暂无这一回执表的获验历史注册，保留原计划版本 1 路径和未支持表门禁。

固定 PostgreSQL 定义见 [回执迁移](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/migration/Definitions/ArticleMutationIdempotencyMigrationDefinitions.cs#L15-L40)，运行时摘要写入见 [v1 命令服务](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/ArticleService.cs#L986-L1012)。

2026-11-15 在 PostgreSQL 18.7 使用固定回执 DDL 和合成旧数据，验证了版本 2 暂存、中断恢复、源摘要变化拒绝、原备份独立恢复和断开旧库后的只读投影校验。源或候选移除对应唯一性约束时均被拒绝。SQLite 3.54.0 与 MySQL 8.4.13 的版本 1 文章导入及 SQLite 旧源的定时、回滚和权利投影回归也通过。原始输出与输入摘要见 `artifacts/native-migration/legacy-create-command-20261114T194650Z.log`。

旧出站事件由 `article_mutation_outbox` 主行与 `article_mutation_outbox_edge` 逐边记录共同描述。旧分派器在七个必需边为 `completed` 或 `skipped` 后才将主行标为 `processed`，并清空认领信息。通知和完整性证明属于可选边，核对时继续区分。后续可先保全这类已完成的主行与边、原始 JSON 和投递键。`pending`、`processing`、`poison` 则需要先排空或单独对账，迁移工具不能从旧回执判定下游已投递。有效的版本 2 草稿创建事件可无发布、版权和责任坐标。PostgreSQL 边表有可复用的固定历史 DDL，主表最终结构来自 v1 CodeFirst 实体及后续列迁移。冻结版本的 SQLite 与 MySQL 离线代表性源库注册不含这两个表。[完成条件](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Background/ArticleMutationOutboxDispatcher.cs#L968-L998) · [草稿写入](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Authoring/PostgresArticleCreatePersistence.cs#L195-L217) · [边表和认领迁移](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/migration/Definitions/AuthoringAndIntegrityMigrationDefinitions.cs#L345-L396)

#### 保全已处理的发布出站事件

当前范围接受 PostgreSQL 中由常规文章创建流程生成、初始即发布的版本 2 `created` 事件。每篇文章只接受一条。主行须有正整数存储 ID、精确的非空小写 `N` 格式事件 UUID、`processed`、处理时间和空认领字段。JSON 须符合固定写入字段集，重复键及旧别名会被拒绝。文章、首次修订、首次发布和版权快照必须一致。若原事件绑定了责任快照，同时核对其 ID 和版本。分类和标签与首次修订比较。保留 JSON 的原始时间字节，两个时间先作完整精度比较，再与数据库微秒坐标相比。保留 `next_retry_at` 原值，领取时写入的租约截止可能晚于完成时间。[固定写入](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/ArticlePublicationTransition.cs#L208-L232) · [领取时钟](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Background/ArticleMutationOutboxDispatcher.cs#L654-L677)

逐行核验主键、每个事件的边名唯一性、孤立边、七个必需边及投递键。七个必需边必须全部为 `completed`，可选通知与证明边可缺失，存在时也必须为 `completed`。只保留每边最后状态、尝试次数和更新时间。可选边失败、旧 `skipped` 原因、诊断边 `article-outbox-replay`、范围外事件或活动认领均会停止整批。`pending`、`processing` 和 `poison` 分别报告计数。投递键为原事件 ID 与边名按固定规则计算的 SHA-256。键值一致可以核对记录，外部投递结果还要单独对账。[边契约与键](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/ArticleMutationSideEffects.cs#L42-L117) · [可选边失败](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/ArticleMutationSideEffects.cs#L410-L442)

工具在同一个只读来源快照中按主键枚举两张表，最多读取 5,000 个事件、45,000 条边和累计 32 MiB 的 JSON，单条 JSON 上限为 16 KiB。表只存在一侧、数据越界或存在未支持状态时整批停止。现有迁移命令使用计划版本 3，绑定精确行数、顺序摘要和备份，并允许同一计划同时带入可验证的旧建文回执。第三检查点在一个事务内写入 `shadow_article_mutation_outbox` 和 `shadow_article_mutation_outbox_edge`，复验数量和原数据摘要后提交。候选永远禁止启动，隔离记录不参与运行时 `blog_outbox` 或公开投影水位。此前 v1 的 PostgreSQL 源码测试覆盖了重试与重新认领、过期事件跳过、重启防重复投递，部分下游由测试替身提供。[重试及重新认领](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/tests/backend/Integration/SchemaMigrationIntegrationTests.cs#L1229-L1278) · [跳过和重启](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/tests/backend/Integration/ArticleMutationVersionedOutboxIntegrationTests.cs#L510-L568)

2026-11-15 用 PostgreSQL 18.7 和 SDK 10.0.404，通过冻结边表 DDL 及与固定实体一致的合成主表测试。回读保留了一个事件、八条边和原 JSON 字节。测试覆盖第三阶段中断恢复、逐边摘要、原源只读、断开源库后的验证、篡改拒绝和永久隔离。实际旧部署数据及其下游投递仍待核对。见 `artifacts/native-migration/legacy-processed-outbox-20261115T003938Z.log`。

同一范围内，计划版本 4 增加常规文章更新生成的第二次即时发布 `updated`。要求同篇文章具备完整的首次 `created` 事件，待归档的事件对应第二修订和第二发布。前后公开分类与标签各自对照相应的不可变修订，且两次事件的七个必需边均满足完成条件。首次事件的 JSON 时间必须与存储时间完全吻合。第二次发布的事件时间与实际第二次发布时间一致。内容和策略按普通旧更新使用的首发存储时间验证。写入第二修订的旧管理员必须存在，数字身份留在隔离修订。旧 `article_mutation_command` 仍只表示建文。此切片保全旧记录及其原始身份，运行时权限、更新命令、队列和下游投递均维持现有隔离。第二次发布带新的责任快照、未记录前态及范围外发布顺序会阻止归档。[普通更新入队](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/ArticleService.Mutations.cs#L413-L483)

2026-11-15 在 PostgreSQL 18.7 用 `tests/Integration/Migration/legacy-outbox.sh --republish` 验证两个事件及 14 条边，核对分类与标签变化、旧发布人从管理员 7 变为 8、原 JSON 和逐边投递键。复验可在源库断开和目标事务只读时完成。测试拒绝缺失或时间不符的首发事件、错误分类、权利摘要篡改、额外责任、重复发布事件和未完成处理。见 `artifacts/native-migration/legacy-republish-outbox-20261115T010630Z.log`。

计划版本 5 保全一个有完整先序的公开回滚。首发 `created` 和第二次即时发布 `updated` 均须通过原验证。第三次发布是当前可见的第三修订，旧站以 `updated` 记录事件，修订回滚来源为同篇文章首发的第一修订。核对第二次发布的公开分类和标签、回滚后的分类和标签、第三次实际发布时间和回滚原因。用首发存储时间独立重算原始和回滚权利摘要，验证内容和权利字段系从原始修订复制。责任快照须从第一修订复制，有独立的原始标识与创建时钟。旧站将责任快照、第三个发布和回滚修订分别持久化，迁移保留各自坐标及原事件 JSON 和逐边投递键。暂存要求旧回滚操作者存在，之后的演练投影还要求与审核过的归属映射吻合。发生在非当前发布、缺少旧前序、没有精确责任来源或涉及定时发布的回滚仍会阻止本流程归档。隔离候选继续拒绝启动，运行时回滚、命令和队列保持空白。[回滚入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/AuthoringEndpoints.WorkflowRoutes.cs#L182-L223) · [旧回滚及责任复制](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/ArticleService.Mutations.cs#L841-L875)

2026-11-15 在 PostgreSQL 18.7 用 `tests/Integration/Migration/legacy-outbox.sh --rollback` 验证三个事件、21 条边、原始 JSON 和逐边投递键。测试覆盖第二次发布事件缺失、回滚前分类标签不符、原权利摘要错误、责任副本内容或时间不符和错误回滚来源。候选篡改被拒绝，恢复原值后在源库断开及目标只读条件下得到相同投影摘要。版本 3、版本 4 和 SQLite 到 PostgreSQL 的旧投影回归也通过。见 `artifacts/native-migration/legacy-rollback-outbox-exact-20261115T013535Z.log` 和 `artifacts/native-migration/legacy-rollback-outbox-20261115T013151Z.log`。

### 在独立临时库演练公开读取

`bash tests/Integration/Migration/legacy-runtime.sh` 需要预编译的 v2 服务、迁移 CLI 和 FsusUI 前端构建产物。脚本自行创建只开放私有 Unix socket 的 PostgreSQL 实例。旧格式合成源库只有一篇即时首发文章，包含不可变修订和权利、分类、标签别名及七条已完成的出站边。源内容没有附件、责任快照、定时任务或凭据，权利快照的证明绑定关闭。[固定 v1 首发写入路径](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/ArticleService.cs#L739-L835)

源数据通过计划、暂存、投影和只读复验进入原隔离库。测试再将明确列出的表和序列状态写入另一个新建的 v2 站点库，保留文章、修订、发布和权利标识。文章所有者的外键只对应禁用的演练账号。旧事件及投递记录留在原隔离库，新库没有历史操作者、命令、出站事件或原生证明。演练先检查错误站点拒绝和事务中断回退，逐表回读并核验新库的备份在第三个空库中恢复一致，再以默认服务启动新库。原隔离库经实际服务验证会在监听前拒绝启动。[写入及只读回读脚本](../tests/Integration/Migration/legacy-runtime-transfer.sql)

2026-11-15 在 PostgreSQL 18.7 使用 SDK 10.0.404、Node 24.16.0 和独立校验的 `f14cb4d` 前端包通过。公开 HTML、AEDS、分类、标签别名、搜索和索引代次重启前后摘要相同。匿名草稿和旧格式登录请求被拒绝，也未暴露媒体或证明。停服后的全表和序列测量与演练备份一致，原隔离库再次通过只读核验，临时资源已清理。此脚本只供合成数据演练。真实旧站的全部领域数据、凭据、附件、权利证明和写入冻结仍按本文启用条件独立核验。见 `artifacts/native-migration/legacy-runtime.KVmUu9ae/run.txt` 和 `artifacts/native-migration/legacy-runtime-native-20261115T020944Z.log`。

`bash tests/Integration/Migration/legacy-runtime.sh --rollback` 使用已核验的计划版本 5 夹具，按首发、再发布和公开回滚的顺序比对旧源与原隔离库。回滚从旧修订 1 复制正文和分类标签，创建修订 3 和第三次发布。原全局修订标识、发布时间、责任快照、旧操作者、回滚理由及三条事件和 21 条投递边在原隔离库核验并留存。新库保留三条 v2 修订及对应的权利关联，并用一个 `retained-active` 发布边界表示仍公开的修订 3。新页面保留公开修订的旧作者摘要。原权利快照的证明绑定开启，夹具没有已签发的证明。默认服务可以读取第三次发布的权利和正文，旧发布坐标不可用于公开读取，过往签名和新投递事件均不会由演练生成。[旧源与隔离库比对](../tests/Integration/Migration/legacy-runtime-rollback-custody.sql)

2026-11-15 使用已独立校验的 `ecbff9d` 发布包，在 PostgreSQL 18.7 上通过回滚与首发两种演练。回滚模式在原库和隔离库之间逐项比对 44 条记录，复验三条原始事件 JSON 的摘要和 21 条投递键。副本恢复后公开修订 3、发布 `900000003` 和权利 `702`。前两次发布坐标被拒绝，第二次发布的内容不出现在公开页面或搜索中。两个模式都完成重启摘要复验、停止后的全表及序列比较，并清理各自拥有的数据库、副本和临时目录。见 `artifacts/native-migration/legacy-runtime.7jHj6mG1/run.txt` 和 `artifacts/native-migration/legacy-runtime-rollback-native-20261115T022901Z.log`。

### 启用已审核的即时发布文章

对已经过 `legacy import verify` 的 PostgreSQL 隔离投影，可在独立运行副本启用最多 32 篇文章。计划版本 3 要求每篇只有首次即时发布，版本 4 要求每篇依次即时首发、普通再发布。两种计划均要求完整修订、发布坐标、对应权利、每次发布的原出站事件和七条已完成的投递边，并核对当前权利与最后一次公开快照。附件、定时发布、责任快照、已启用的证明绑定及其他未转换的有效数据仍会阻塞启用。旧版管理员操作者、出站事件及投递边留在隔离库。

为运行副本独立审核并预置原映射 UUID 对应的禁用所有者。目标须为 `fsusv2_import_runtime_*` 当前库，通过所有者专用 Unix socket 连接且 PostgreSQL 不监听 TCP。另行备份该基线并保存清单 SHA-256。使用 `FSUSBLOG_IMPORT_DB` 指向原隔离库，使用 `FSUSBLOG_RELEASE_ACTIVATION_DB` 指向运行副本。导出计划，审核绑定的来源、目标及回退摘要和待写关系，再独立保管审批文件 SHA-256。

```bash
migrate=(dotnet src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll)
release_args=("$plan" "$plan_sha256" "$quarantine_backup" "$quarantine_backup_sha256"
    "$runtime_site" "$runtime_rollback" "$runtime_rollback_sha256")
"${migrate[@]}" legacy import release-plan "${release_args[@]}" > "$release_approval"
"${migrate[@]}" legacy import release-activate "${release_args[@]}" "$release_approval" "$approved_sha256"
```

启用在同一事务中复制核验过的业务行、推进相应序列并做独立回读。服务开始写入前，同一审批可复验完整提交；部分状态或任何其他基线变更均被拒绝。原隔离库保持禁用，运行副本也没有新增登录权限。计划版本 5 的公开回滚仍须保留并转换旧责任治理、历史责任快照和对应的公开读取契约。当前启动副本不会推定 v2 管理员替代旧责任或签发旧内容证明。完整 v1 归档认证、旧会话废止、其余历史和生产切换仍需独立验收。

PostgreSQL 18.7 的 `legacy-runtime.sh --activate` 从原生旧库归档恢复一篇首发文章，再运行正式离线命令。另一个库实地恢复了启用前基线和非空启用结果。替换隔离来源、替换为同站点的另一物理目标库及修改权利均被拒绝。恢复出的运行副本经真实 Kestrel 验证公开 HTML、AEDS、权利、分类、标签别名及搜索，重启前后读回相同。原隔离库仍拒绝启动，临时资源已清理。见 `artifacts/legacy-first-release-activation-967805c/native-activation-final.log`。

PostgreSQL 18.7 的 `legacy-runtime.sh --activate-republish` 从旧库归档恢复首发与再发布链。两条原事件和 14 条投递边仍由隔离库保管。正式命令启用运行副本并接受同一审批的复验，修改已被取代的第一条修订会使复验失败。再次归档并恢复后的 Kestrel 返回修订 2、发布 `900000002` 和权利 `701`，拒绝前一发布的公开关联与证明坐标。相同构建也通过首发启用，并拒绝把版本 5 的责任快照作为普通再发布启用。见 `artifacts/legacy-republish-activation-72d684d/native-suite-status-2.txt`。

### 离线验看附件来源

停止旧站写入后，从同一个时间点取得只读数据库和共享存储快照。用经过验证的实际目录分别指定旧站 `assets/public` 与 `assets/private`。旧版 `tools/operations/backup-site.sh` 仅归档一个可配置的 uploads 目录，通常无法从旧备份单独取得这两棵目录。验收报告请放在只有操作者可读的目录。

```bash
umask 077
dotnet run --no-build --project src/Migrate -- legacy assets postgres \
  "$frozen_public_assets" "$frozen_private_assets" > "$asset_report"
```

在 macOS 或 Linux 上，此步骤以只读事务和无符号链接跟随的目录句柄检查旧库 `content_asset` 与 `content_asset_reference`。逐件检查 UUID、存储类型、字节数、数据库声明的 SHA-256 和实读 SHA-256。私有件还检查 UUID 对应的存储路径及旧 `admin_principal` 所有者存在。引用使用旧文章 ID 或全局修订 ID，核对修订所属文章；报告保留元数据与关联摘要，省略文件路径及替代文本。一次最多检查 5,000 件附件、20,000 条引用和 1 GiB 字节。

报告的 `issues` 按类计数。旧公有件无原始摘要、文件缺失或改变、私有件所有者未解析、草稿或模板关联、清理状态及尚存的旧 URL 附件表会有对应的条目。退出码 2 表示读取完成且存在这些未解决项，退出码 1 表示提供者、数据格式或输入失败。报告始终返回 `readyToApply: false`。核查只读。默认的 `legacy import` 会拒绝非空附件关系，下文给出已核实的私有修订附件暂存方式。授权迁移、运行时媒体安装、历史链接改写和启用仍需实现。

旧版编号 `20260826-post-content-asset-id-cutover` 的附件迁移 DDL 以 PostgreSQL 注册。SQLite 与 MySQL 可验看对同一字段结构的离线快照，MySQL 的测试使用 `CHAR(36)` UUID；这只确认快照读取能力。编号切换前的 URL-only 来源无法出具字节权威报告。

2026-11-15 在 SDK 10.0.404 下运行 `tests/Integration/Migration/legacy-assets.sh [postgres|sqlite|mysql]`。三个样本均验证公有和私有件，同时拒绝相同长度的内容篡改、文件缺失或改名、符号链接、错误的旧所有者或修订号。草稿引用、清理队列和缺失旧摘要会生成逐项结果，当权威表结构不存在则停止。精确输入摘要与原始输出见本地 `artifacts/native-migration/assets-20261114T163811.log`。

### 演练附件的隔离打包

用上一节的冻结源快照和一个单独的空 v2 PostgreSQL 候选。以 `FSUSBLOG_IMPORT_DB` 指定本机 Unix socket 的 `fsusv2_import_*` 候选。候选需已建当前结构、尚未进行文章暂存且没有业务行，可单独预置计划需要的启用作者。v2 目标站点 UUID 取自 `authoring_recovery_site.site_id`。旧库没有相同的站点标识，旧站 UUID 由操作者从独立来源记录确认并提供。

```bash
umask 077
dotnet run --no-build --project src/Migrate -- legacy assets rehearsal plan postgres \
  "$frozen_public_assets" "$frozen_private_assets" "$source_site_uuid" "$target_site_uuid" > "$draft"
```

核对草案的来源、目标和附件数量，基于已审核的账号对应关系填写每个 `owners[].targetUserId`，得到权限为 0400 或 0600 的审核文件。每个旧管理员 ID 只接受一个不同的现有 v2 作者 UUID。独立记录审核文件的原始字节 SHA-256。准备站点和备份目录之外、归当前用户所有且权限为 0700 的离线输出目录。

```bash
dotnet run --no-build --project src/Migrate -- legacy assets rehearsal copy postgres \
  "$frozen_public_assets" "$frozen_private_assets" "$reviewed_json" "$reviewed_sha256" "$quarantine_parent" asset-drill
dotnet run --no-build --project src/Migrate -- legacy assets rehearsal verify \
  "$quarantine_parent/asset-drill" "$manifest_sha256"
```

复制会重测来源附件 SHA-256、原始引用与归属摘要、已审核站点、候选结构及作者。只要存在任意附件核查问题，整批都停止。PostgreSQL 源与候选必须有不同的集群系统标识，即使数据库名称不同也拒绝同一集群。该限制用于本项隔离演练，源和目标的只读连接需能执行 `pg_catalog.pg_control_system()`。SQLite 快照的审核还绑定整个文件 SHA-256。

包只写入离线目录，目录模式 0500、单链接普通文件模式 0400。密封清单保存原始附件标识、存储类、精确路径和摘要，保留旧文章及全局修订 ID、引用计数、替代文本及已审核归属。请按原始私有附件保管包。成功回读后输出 `manifestSha256`，应独立保存该值。无数据库连接的 `verify` 按此值核对清单、精确文件集合及每件摘要。该流程不写入任何数据库或站点媒体目录，`readyToApply` 恒为 `false`。

2026-11-15 在 macOS ARM64 使用 SDK 10.0.404 运行 `tests/Integration/Migration/legacy-asset-rehearsal.sh`。SQLite 3.54.0 与独立 PostgreSQL 18.7 源均完成公有和私有件打包及离线回读。验证覆盖同集群跨库、已暂存库、审核与目标站点变化、所有者不符、已有包名称、文件篡改、链接、额外成员与扩展 ACL。输入及候选业务状态均保持一致，自建实例、数据库和目录已清理。MySQL 的附件盘点另有测试，打包链路及 Linux 文件实现尚未实测。原始结果见 `artifacts/native-migration/assets-package-final-20261114T171139.log`。

### 私有修订附件与数据库共同恢复演练

在上述两个独立 PostgreSQL 实例间，先用实际恢复的 v1 来源库和冻结媒体完成 `legacy assets rehearsal copy`，然后向同一个候选执行 `legacy import`。`plan`、`apply`、`project`、`verify` 都在末尾追加 `--media "$package" "$media_manifest_sha256"`。有时间评估选项时先传 `--evaluate-schedules-at UTC`。使用独立保存的原始清单摘要，恢复副本可用不同的合规目录。来源和目标数据库身份、已审核站点、附件 SHA-256、两张来源表的实测摘要、旧管理员及目标作者、文章 ID 和旧全局修订号必须吻合。目标作者的映射须与文章归属映射相同。范围限于启用的非空私有文件，以及未曾发布的修订引用。旧版附件切换会保留既有的非公有引用。 [固定 v1 回填实现](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/migration/ContentAssetCutoverBackfill.cs#L536-L592)

文章、修订与附件的类型化影子行一并提交第一阶段检查点。原文件保持在只读包内。后续投影或回读缺少同一个包及原摘要时会拒绝，现有 `public.private_media` 和文章媒体关联保持空，候选版本为 `-1`。公有文件、已发布修订、正文或封面内链接、草稿来源以及未完成清理依然阻塞。此路径需要有集群标识读取权限的专用旧库只读身份。其他 PostgreSQL 导入可继续使用目录及连接端点核验。

`bash tests/Integration/Migration/legacy-joined-media.sh` 需要已构建的迁移 CLI 和 PostgreSQL 18 客户端及服务端。2026-11-16 在两个一次性 PostgreSQL 18.7 Unix socket 实例通过。原生归档恢复至不同 v1 数据库 OID，3 字节私有文件从独立副本恢复。旧文章 `42` 的全局修订 `5000000003` 及旧管理员 `7` 在同一检查点回读核验。错误来源库、已发布修订、引用或字节变更、省略文件包、已改的候选关联、恢复后的其他目标库均被拒绝。成功续跑的三个检查点相同，重新放入私有目录的密封包通过了候选回读，另一个空库从导入前备份恢复并核对了数据库及其空媒体集。候选仍拒绝启动，两个实例和成功运行的临时目录已清理。本地证据为 `artifacts/legacy-joined-media-2ec1b97/native-3.log`。此演练还未验证实际 v1 加密备份包、非空 v2 运行时媒体安装或生产切换。

### 准备并核验隔离私有图像

在已有联合媒体包且文章候选通过隔离投影后，使用 `media-request` 从同一个原始计划和候选导出准备请求。请求包含源文件 SHA-256、可处理的图像格式和尺寸、已审核的所有者、全局旧修订与 v2 修订键，以及旧引用计数和替代文本。使用权限为 0600 的文件保存，并独立记录请求 SHA-256。准备工具使用 v2 服务的现行图像规范化实现，输入和输出摘要分别保留。Linux ARM64 上 SkiaSharp 还依赖 `libfontconfig.so.1`，Ubuntu 实测使用 `libfontconfig1`。 缺少依赖时准备失败。macOS 和 Linux 的规范化器指纹各自批准。先用可信发布包核对服务器与规范化器文件。使用 `legacy-media normalizer` 输出的文件和指纹核对即将运行的规范化器，再独立批准该指纹和准备结果清单摘要。 [Linux 实测](../artifacts/legacy-media-prepared-de88453/linux-media-provisioned-main.txt)

```bash
umask 077
migrate=(dotnet src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll)
"${migrate[@]}" legacy import media-request "$plan" "$plan_sha256" "$backup" "$backup_manifest_sha256" \
  --media "$custody_package" "$custody_manifest_sha256" > "$request"
dotnet "$verified_server_dll" legacy-media normalizer
dotnet "$verified_server_dll" legacy-media prepare "$request" "$request_sha256" "$custody_package" \
  "$normalizer_sha256" "$private_output_parent" prepared
"${migrate[@]}" legacy import media-verify "$plan" "$plan_sha256" "$backup" "$backup_manifest_sha256" \
  --prepared "$private_output_parent/prepared" "$prepared_manifest_sha256" "$normalizer_sha256" \
  --media "$custody_package" "$custody_manifest_sha256"
```

`media-verify` 独立重新读取隔离候选、源包和备份，重新导出同一请求，核对批准的清单和规范化器摘要，并逐件检查准备包的成员、文件权限、长度、格式和字节摘要。批准摘要来自可信操作记录，制品中的同名字段本身不能授予权限。请求及结果是明确的旧媒体来源记录，尚未在现行上传表中注册操作，也未把旧引用改为可访问附件。整个过程保持候选为 `-1`，`readyToApply` 为 `false`。

`bash tests/Integration/Migration/legacy-joined-media.sh --prepared` 在两个 PostgreSQL 18.7 Unix socket 实例中恢复原生旧库和私有 PNG，再用已构建的真实 Server CLI 准备图像，并从独立目录副本回读验证。旧文章 `42` 的全局修订 `5000000003` 仍映射到 v2 修订 `3`，引用计数及替代文本经重新导出的请求核对。另一件输入与原图的像素、尺寸及归档长度相同，实际规范化制品逐字节一致，但因原始来源摘要不同而被拒绝。错误规范化器摘要和准备文件变更也被拒绝。旧 TXT 演练仍证明联合保管，图像准备命令拒绝该格式。全部运行保持私有媒体表为空，复验导入前恢复库，并清理本次服务器和临时目录。本地证据为 `artifacts/legacy-media-prepared-de88453/native-prepared-final.log` 和 `native-text.log`。

### 在独立运行副本中离线启用私有图片

启用使用已核验的原始隔离库和准备包。提前建立一个当前结构的独立运行副本，复核作者账号、文章及其私有当前修订，确保相关当前发布和不可变发布历史等于隔离投影。运行副本必须使用独立站点 UUID、`fsusv2_import_runtime_*` 库名和进程所有的私有 Unix socket 目录，PostgreSQL 不监听 TCP。先停止服务和写入者，安装导入来源结构，再对副本和空媒体目录做配对备份。使用 `FSUSBLOG_IMPORT_DB` 指向原隔离库，`FSUSBLOG_MEDIA_ACTIVATION_DB` 指向明确审核的运行副本。

```bash
FSUSBLOG_DB="$runtime_dsn" "${migrate[@]}" private-media-import-origin schema
source_args=("$plan" "$plan_sha256" "$backup" "$backup_manifest_sha256")
activation_args=(--destination "$runtime_media" "$runtime_site_uuid" "$runtime_rollback" "$runtime_rollback_sha256"
  --prepared "$private_output_parent/prepared" "$prepared_manifest_sha256" "$normalizer_sha256"
  --media "$custody_package" "$custody_manifest_sha256")
"${migrate[@]}" legacy import media-activation-plan "${source_args[@]}" "${activation_args[@]}" > "$approval"
"${migrate[@]}" legacy import media-activate "${source_args[@]}" --approval "$approval" "$approved_sha256" "${activation_args[@]}"
```

独立审核计划中的库和站点标识、媒体目录、回退清单、作者和修订，并记录批准的 SHA-256。每批最多 32 件已规范化 PNG 或 JPEG、128 条引用、64 MiB 规范化结果。每个修订最多 32 件。每条引用的旧计数须为 1，同一附件可分别关联同一所有者的多个从未发布过的修订。每个引用都核对独立作者与文章、所引修订及发布历史。沿用旧来源 UUID、旧全局修订、替代文本和引用计数，上传命令和请求摘要留空。核对并同步整批文件后，一次提交全部附件、引用与来源。原始隔离库继续禁止启动，公开附件表保持独立。既有单件当前修订审批继续使用原始格式和 SHA-256。

提交回执丢失时，使用原批准文件复核这个精确的事务及媒体文件。数据库仍处于批准的空媒体状态时，允许原批次中部分已验证的最终文件留在目录中，续跑会补齐其余文件。发现数据库行未成批提交、已提交记录缺少文件、存在未知文件或任一字节失配时，从已验证的数据库和媒体配对恢复。原始时间、来源摘要和目标运行副本的审批键留在导入记录。历史私有引用可以保留，预览票据仍依当前修订签发。独立副本之外的站点及历史公开修订仍需单独验收。

`bash tests/Integration/Migration/legacy-joined-media.sh --activate` 在独立 PostgreSQL 18.7 实例及真正的 Server 中通过。从 v1 归档恢复的 86 字节原图经规范化得到 99 字节 PNG。启用及备份恢复保留原附件 UUID、旧全局修订 `5000000003`、当前 v2 修订 `3`、原所有者和替代文本。实际落盘、原审批重跑、仅剩已落盘文件后的续跑、已提交文件丢失时拒绝均已验收。恢复非空配对数据后，新签发的所有者会话通过原图和草稿预览获取完全相同的字节，匿名和其他作者均不能读取。公开页面继续提供修订 `2`。导入前备份已另行恢复，所有本机进程和临时目录已清理。本地证据位于 `artifacts/legacy-media-activation-a649068/native-final.log`。

批量演练使用两名独立审核的作者、三张不同 PNG 和四条原引用，其中一件跨同一文章的历史与当前私有修订复用。旧库与原图从配对副本恢复后，原生 PostgreSQL 验证了批次初次落盘、部分文件续跑、部分数据库行与错误字节拒绝、回退和完整非空备份恢复。真实 Kestrel 验证了五次所有者读取、八次无效或越权拒绝，历史修订预览拒绝，既有公开修订仍保持。新版 CLI 也核对旧版实际签出的单件审批，规范字节和 SHA-256 相同。见本地 `artifacts/legacy-media-batch-09e4b27/native-batch-2.log` 和 `native-single-compat-final-2.log`。

固定 v1 私有图像策略接受 `.jpg`、`.jpeg` 和 `image/jpeg`。混合批次原生演练将 842 字节的旧 JPEG 与两张 PNG 一起恢复、准备、启用，并复验导入前后备份。运行库保留原附件 UUID、来源和两个私有修订引用，写入 v2 原生 JPEG 格式。恢复后，所有者的原图及当前草稿预览均以 `image/jpeg` 返回与准备包完全一致的字节。见本地 `artifacts/legacy-media-jpeg-82d0180/native-jpeg-1.log`。 [固定 v1 私有图像策略](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/PrivateAssets/LocalPrivateAssetStore.cs#L227-L237)

### 离线核对身份兼容性

```bash
umask 077
dotnet run --no-build --project src/Migrate -- legacy identity postgres > "$identity_report"
```

从同一只读旧库快照分别核对 `sys_user` 和 `admin_principal`，保留各自的整数 ID 命名空间。报告只列出身份与关联表的行数、缺表和各类不兼容项。`sourceIdentitySha256` 对固定源码版本、来源提供者及已选字段的投影计算摘要。TOTP 加密内容、恢复码摘要、会话令牌和审计正文只检查必要的存在性或生命周期，不会进入投影或报告。`sessionStateAtUtc` 记录用于区分活跃和过期会话的时刻。摘要用于同一来源的预检，比对完整凭据及备份仍需独立证明。

读取 Passkey 的归属、编码、签名计数与同步状态，并指出同一管理员的多凭据约束。公钥是否可用还需独立核对算法、旧 RP ID、来源域名和凭据注册语义。旧管理员 root 与未映射授权显式计数，普通账号的 subject、注册及封禁代次和 Passkey Signal 代次也需要保留。报告独立统计 TOTP、恢复密钥的有效或已用及已撤销状态、仍有效的持久会话、已泄露或撤销会话、令牌换代记录和注册会话。

身份投影需要旧库实际表结构，缺少必需表或列时退出 1。报告发现缺少相关权威关系、未知权限或其他不兼容项时退出 2。`readyToApply` 恒为 `false`。旧会话和恢复授权需要已证明的撤销与重新登记流程，旧权利需要显式映射。此步骤读取旧库，不生成 v2 身份、认证材料或映射。

2026-11-15 在 SDK 10.0.404 下运行 `tests/Integration/Migration/legacy-identity.sh [postgres|sqlite|mysql]`。PostgreSQL 18.7、SQLite 3.54.0 和 MySQL 8.4.13 分别通过旧字段形状的隔离样本验证。核对同号的两类主体、跨身份错误绑定、撤销与在用的恢复密钥、当前和历史会话、不认识的权限、缺表和报告脱敏。精确输入摘要与原始输出见本地 `artifacts/native-migration/identity-20261114T164928.log`。

### 演练选定的独立管理员

该流程使用单独的新 v2 PostgreSQL 候选，`FSUSBLOG_IMPORT_DB` 指向本机 Unix socket 的 `fsusv2_import_*` 数据库。用当前迁移工具初始化空库，先生成并独立验证其备份，再保留清单 SHA-256。目标 UUID 读取候选的 `authoring_recovery_site.site_id`，旧站 UUID 由操作者用独立站点记录确认。PostgreSQL 旧源与候选必须属于不同的集群，连接需具备读取 `pg_catalog.pg_control_system()` 的权限。将旧数据库置为冻结的只读来源，SQLite 的来源绑定包含规范文件位置及已选元数据，凭据页不参与读取摘要。

```bash
umask 077
dotnet run --no-build --project src/Migrate -- legacy admin plan postgres \
  "$source_site_uuid" "$target_site_uuid" "$verified_backup_dir" "$manifest_sha256" 42 103 > "$draft"
```

只按 `admin_principal` 的旧正 Int64 ID 选择，普通账号同号无关。审批人员确认旧 handle、状态、验证代次、明确的权限名和新 UUID 映射后，只填写 `principals[].targetAdminId`。权限以旧站每行一个标识的实际格式读取，仅保留能明确识别的 v2 对应项。root、TOTP 或其残留状态、重复或不认识的权限、未知身份状态均拒绝。旧 Passkey 和会话只按归属计数。草案和审核文件含身份元数据，使用操作者私有文件；保存经审核文件的原字节 SHA-256。

```bash
dotnet run --no-build --project src/Migrate -- legacy admin stage \
  "$reviewed_json" "$review_sha256" "$verified_backup_dir" "$manifest_sha256"
dotnet run --no-build --project src/Migrate -- legacy admin verify \
  "$reviewed_json" "$review_sha256" "$verified_backup_dir" "$manifest_sha256" "$candidate_sha256"
```

首次写入在同一事务封禁启动、记录独立管理员映射并写入当前形状的禁用管理员。保留旧管理 handle 和验证代次，为每条记录产生新的 32 字节 WebAuthn handle。审核权限只留在隔离谱系，`public.admin_permission`、邀请、凭据和会话均为空。重新执行 stage 会重读源和目标，verify 使用首次输出的独立 `candidateSha256`、审核文件和备份做只读复验，无需连接源库。数据库标记、备份覆盖、管理员、权限行或隔离结构的变化均会停止演练。候选仅供核验，正式账号权限审批及新凭据登记需要独立完成。

2026-11-15 在 macOS ARM64、SDK 10.0.404 上通过 `tests/Integration/Migration/legacy-admin-rehearsal.sh [postgres|sqlite|mysql]`。SQLite 3.54.0、独立 PostgreSQL 18.7 和 MySQL 8.4.13 的旧结构样本均通过映射、只读复验和独立的 PostgreSQL 备份恢复。PostgreSQL 和 MySQL 使用不能读取原凭据与会话秘密字段的旧源角色。测试拒绝旧根权限或 MFA、变更的来源、修改的管理员与回执、同名约束替换和发布态站点页面，确认普通身份同号不影响结果且旧源保持原样。原始输出与输入摘要见 `artifacts/native-migration/legacy-admin-rehearsal-20261114T184119Z.log`。

文章暂存、当前表投影和附件演练接受新版建库生成的四个站点页面空槽，限于原始 slug、修订号 0 及空正文。若安装了外观激活结构，也只允许修订号 0 的空主题和空字体。分类元数据结构只允许一条启用单例标记、修订号为 0 的初始记录。分类操作回执仍属于业务数据，会阻止在该候选上演练。对照备份时初始记录仍参与摘要。SQLite、PostgreSQL、MySQL 文章暂存与恢复、SQLite 文章投影，以及 SQLite 与独立 PostgreSQL 附件演练都通过了新版初始结构的回归。原始输出见 `artifacts/native-migration/legacy-pristine-baseline-20261114T185057Z.log`。

在 `e7d1117` 结构上复验了默认分类版本与外观、管理员站内信结构共存。无回执的分类版本变更因坐标不一致被拒绝。有匹配回执的版本变更通过结构核验后，因回执偏离导入前备份被拒绝。见 `artifacts/native-migration/legacy-taxonomy-pristine-20261114T192111Z.log` 和 `artifacts/native-migration/legacy-taxonomy-pristine-providers-20261114T192133Z.log`。

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

正式切换前需以代表实际部署结构的数据在本机或指定外部 PostgreSQL 环境演练一次完整流程。至少覆盖导入中断与幂等重跑、私有与已撤回内容、管理员写入和发布的独立权限、旧会话废止、凭据恢复、附件引用、公开投影与同一发布坐标。记录备份及快照摘要、被废止的身份及数量、各组差异、核验开始结束时间与清理结果。目前已验证的 PostgreSQL 局部演练使用合成数据，实际 v1 部署备份与全量切换尚未核验。

启用只允许通过独立验证的当前 schema 和恢复方案。已启用后的故障由前向修复或恢复经验证且与代码版本匹配的备份处理。启用后产生的新写入可能超出备份恢复点，需要记录 RPO、待对账数据和恢复审批。v1 恢复只能连接独立的 v1 备份恢复库。
