# v2 PostgreSQL 离线维护

首次新建空库使用独立的 `FsusBlogV2.Migrate`。服务启动只读取当前版本标记和约定的关系、列及约束，遇到未预置或部分预置的数据库会中止。迁移和应用服务使用各自的数据库身份。服务身份需要读取 catalog 和 `public.v2_schema`，执行业务所需 DML，以及使用 identity 序列。

`FSUSBLOG_DB` 是含显式数据库名的 Npgsql 连接串。凭据从环境或连接配置注入，命令行只传入操作和文件路径。

```bash
dotnet restore src/Migrate/FsusBlogV2.Migrate.csproj --configfile NuGet.Config --locked-mode
dotnet build src/Migrate/FsusBlogV2.Migrate.csproj --no-restore
migrate=(dotnet src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll)
"${migrate[@]}" inventory
"${migrate[@]}" plan > plan.json
"${migrate[@]}" apply plan.json
"${migrate[@]}" verify
```

`inventory` 在只读快照中记录库标识、服务版本、关系、列和键。`inventory --counts` 还会扫描普通表和分区表以获取精确行数，分区父表包含整个子树。使用具有完整可见性的专用只读身份盘点源库。报告中没有业务行内容。`plan` 绑定当前空库的 host、port、库名、库 OID、PostgreSQL 启动时间及组合 SQL 的 SHA-256。`apply` 在同一事务中检查目标和 schema，创建表及约束，提交版本标记。失败时事务回滚，应用中断后先用 `verify` 或 `inventory` 确认结果。换库或 PostgreSQL 重启后需要重新生成计划。

`operator NAME` 创建一个本地作者账号并打印 10 分钟有效的单次登录票据，`operator NAME --reader` 创建无写入能力的账号。已有启用账号使用 `ticket NAME` 申请新票据。票据输出只交给该用户。执行 `revoke NAME` 会推进会话代次并删除未使用票据和已有会话。此批次使用受控票据验证首链路，v1 Passkey、TOTP、旧权限和会话的切换条件见 [v1 → v2 离线数据迁移依据](migration-source.md)。

## v2 数据库备份恢复

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
