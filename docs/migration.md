# v2 PostgreSQL 离线维护

首次新建空库使用独立的 `FsusBlog.V2.Cli`。服务启动只读取当前版本标记和约定的关系、列及约束，遇到未预置或部分预置的数据库会中止。迁移和应用服务使用各自的数据库身份。服务身份需要读取 catalog 和 `public.v2_schema`，执行业务所需 DML，以及使用 identity 序列。

建表 SQL 只嵌入 `FsusBlog.V2.Cli`。服务启动准入与 CLI `verify` 共用 `src/Storage/FsusBlog.V2.Storage.csproj` 编译出的同一份形态校验程序集 `FsusBlog.V2.Storage.dll`，两边都通过工程引用携带，不再各自编译源码副本。

`FSUSBLOG_DB` 是含显式数据库名的 Npgsql 连接串。凭据从环境或连接配置注入，命令行只传入操作和文件路径。

```bash
dotnet restore src/Cli/FsusBlog.V2.Cli.csproj --configfile NuGet.Config --locked-mode
dotnet build src/Cli/FsusBlog.V2.Cli.csproj --no-restore
migrate=(dotnet src/Cli/bin/Debug/net10.0/FsusBlog.V2.Cli.dll)
"${migrate[@]}" inventory
"${migrate[@]}" plan > plan.json
"${migrate[@]}" apply plan.json
"${migrate[@]}" verify
```

`inventory` 在只读快照中记录库标识、服务版本、关系、列和键。`inventory --counts` 还会扫描普通表和分区表以获取精确行数，分区父表包含整个子树。使用具有完整可见性的专用只读身份盘点源库。报告中没有业务行内容。`plan` 绑定当前空库的 host、port、库名、库 OID、PostgreSQL 启动时间及组合 SQL 的 SHA-256。`apply` 在同一事务中检查目标和 schema，创建表及约束，提交版本标记。失败时事务回滚，应用中断后先用 `verify` 或 `inventory` 确认结果。换库或 PostgreSQL 重启后需要重新生成计划。

`operator NAME` 创建一个本地作者账号并打印 10 分钟有效的单次登录票据，`operator NAME --reader` 创建无写入能力的账号。已有启用账号使用 `ticket NAME` 申请新票据。票据输出只交给该用户。执行 `revoke NAME` 会推进会话代次并删除未使用票据和已有会话。V1 账号及数据迁移工具已退役；现行工具不迁入旧凭据或会话。见[退役说明](migration-source.md)。

早期开发库缺少 `authoring_recovery_site` 时，需要停服务、核验备份，再由离线工具执行 `recovery-scope`。命令仅接受其余表结构完全匹配当前签名、版本正确且没有服务租约的库。一旦分配，重跑保留原 UUID。其他旧开发结构需要独立的数据迁移或一次新的空库部署。预先存在的浏览器记录保持原键及到期规则，新数据库 UUID 不会接管旧记录。完整备份恢复保留站点 UUID。

## v2 数据库备份恢复

`tools/site-backup.py` 可生成供离线恢复演练使用的 PostgreSQL 和私有媒体候选。先停止站点及该数据库的离线写入工具，等待上传和删除结束。指定两个绝对路径，备份父目录和源媒体目录均由当前用户持有、模式为 0700，且互相隔离。无媒体时提供独立的空目录。显式设置 `PGDATABASE`、`PGHOST` 和 `PGPORT`，它们须与 `FSUSBLOG_DB` 指向同一源库。使用与服务器同主版本的 `pg_dump` 和受控连接凭据。使用已构建的 CLI DLL，可用 `FSUSBLOG_CLI_DLL` 和 `DOTNET_BIN` 定位。

```bash
python3 tools/site-backup.py capture "$private_backup_parent" "$new_candidate_name" "$source_media_root"
python3 tools/site-backup.py verify "$candidate" "$manifest_sha256"
pg_restore --no-password --single-transaction --exit-on-error --no-owner --no-privileges \
  --dbname "$new_isolated_restore_db" "$candidate/database.dump"
FSUSBLOG_DB="$restore_dsn" python3 tools/site-backup.py verify-restored \
  "$candidate" "$manifest_sha256" "$isolated_restored_media_root"
```

备份期间核验当前结构，锁定 v2 数据库写者和媒体目录。统计业务表、identity 序列和已提交的媒体长度与摘要。原生 `pg_dump` 导入同一个导出快照，复制媒体时核验数据库记录。目录和文件使用已打开的目录句柄约束，拒绝符号链接、共享硬链接和非专用私有权限。输出新目录包含 `database.dump`、`media/` 和最后写入的 `manifest.json`。将打印的清单 SHA-256 保存到受独立保护的记录中。

验证通过后只向新建的隔离库恢复可信的 dump，并把候选媒体文件复制到新建的 0700 恢复目录。恢复库和媒体目录由命令独立回读比对；候选及恢复目录需要保持隔离冻结。候选包含明文数据库与媒体，须在加密保护的离线存储中使用。当前范围是 PostgreSQL 和私有媒体的可恢复性，不包含 v1 的认证加密信封、密钥轮换、外部对象存储、扩展包仓库、运行密钥、角色 ACL 或生产切换。未解决的媒体阶段、额外数据库扩展或大对象会阻塞。

2026-11-14 23:52，.NET SDK 10.0.404 与 PostgreSQL 18.7 上的原生演练退出码为 0。真实恢复的表、序列和媒体均匹配。当前数据库写者、待落盘媒体、暂存上传分片、不同来源连接、错误主版本、已存在候选名、错误清单摘要、媒体符号链接和恢复后业务数据变更均被拒绝。两个临时库和媒体目录已独立确认清理。[演练入口](../tests/Integration/Migration/backup-candidate.sh)，本地原始证据 `artifacts/native-migration/backup-20261114T155233.log`。

用已提供的 PostgreSQL 客户端在受控目录备份。操作前为 `pg_dump` 及 `pg_restore` 设置对应连接环境和权限。恢复到独立、新建的空库。数据库归属和权限应使用验证过的原配置重新设置。

```bash
umask 077
pg_dump --no-password --format=custom --dbname "$source_db" --file "$backup_file"
shasum -a 256 "$backup_file"
pg_restore --no-password --single-transaction --exit-on-error --dbname "$restore_db" "$backup_file"
FSUSBLOG_DB="$restore_dsn" "${migrate[@]}" verify
```

记录时保存 dump 摘要、工具版本、工作树 Git 提交、数据库快照时间、预期行数和恢复校验结果。恢复核验也要比较业务数据、附件及对应密钥。当前 `verify` 可以检查关系、列、约束和文章当前发布坐标。前台站点的完整恢复验收还包括站点外的配置和对象。恢复后禁止并行对同一逻辑站点开放两个写端。

[本机 PostgreSQL 用例](../tests/Integration/Migration/verify.sh) 需要专用测试集群。提供用于同一集群的 `FSUSBLOG_TEST_DB`、`PGHOST`、`PGPORT`、`PGUSER`，libpq 密码使用 `PGPASSFILE` 或已有受控设置。需要 CREATEDB 权限和 `psql`、`pg_dump`、`pg_restore`、`openssl`、`xxd`、`rg`。脚本只创建并删除本次运行随机命名的两个数据库，检查空库拒绝、错误目标、当前结构、重复 apply、签发和撤销、错误版本、引用失配和备份恢复，保留原始退出码并报告清理失败。

2026-11-14 21:18 在 macOS arm64 的独立 PostgreSQL 18.7 实例上通过上述用例，SDK 为 10.0.302，运行库为 10.0.10，退出码为 0。候选含站内信、分类标签和 Canvas 表。真实备份恢复保留了同一篇文章不同的公开修订和草稿，以及发布计数和序号。两种发布坐标失配均被拒绝，服务端设置只读时验证成功。确认两个临时数据库均已删除，临时备份文件已清理。工作树基准提交为 `6f10e0a4d7d9b07ae7df4511bd8f4049a3d26037`，候选工作树文件摘要和原始输出在本地 `artifacts/native-migration/run-20261114T131849.log`。v1 数据转换和生产恢复仍需验收。Docker 测试留给指定环境。
