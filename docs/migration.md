# PostgreSQL 离线维护与备份恢复

> **角色**：运维操作手册
> **适用对象**：站点部署者与数据库管理员
> **权威依据**：子命令定义以 [`src/Cli/Program.cs`](../src/Cli/Program.cs) 为准，建表 SQL 以 `src/Cli/Schema/01..04*.sql` 为准，启动只读校验以 [`src/Storage/CurrentSchema.cs`](../src/Storage/CurrentSchema.cs) 为准。

## 1. 在线服务与离线 CLI 隔离

- 建表 SQL 仅嵌入独立离线维护工具 `FsusBlog.V2.Cli`（`src/Cli/Schema/01-core.sql` 至 `04-operations.sql`）。
- 在线服务 `FsusBlog.V2.Server` 与 CLI 通过工程引用共享同一份形态校验程序集 `FsusBlog.V2.Storage.dll`。服务启动只以 DML-only 账号只读核验 `public.v2_schema` 版本标记、表结构、列与约束，遇到未初始化或漂移数据库立即 fail-closed 中止，绝不在线执行 DDL。
- 生产环境应为 `Server` 与 `Cli` 分配分离的数据库账号；`Server` 账号仅需 catalog 与 `public.v2_schema` 读权限、业务表 DML 与 identity 序列权限。
- 凭据通过 `FSUSBLOG_DB`（含显式数据库名的 Npgsql 连接串）从环境注入，命令行只传入操作与文件路径。

## 2. 空库初始化与结构核验

```bash
dotnet restore src/Cli/FsusBlog.V2.Cli.csproj --configfile NuGet.Config --locked-mode
dotnet build src/Cli/FsusBlog.V2.Cli.csproj -c Release --no-restore
cli=(dotnet src/Cli/bin/Release/net10.0/FsusBlog.V2.Cli.dll)

"${cli[@]}" inventory
"${cli[@]}" plan > plan.json
"${cli[@]}" apply plan.json
"${cli[@]}" verify
```

- `inventory`：只读事务盘点目标库标识、版本、关系、列与键（不输出业务数据）；`inventory --counts` 附加精确行数统计。
- `plan`：绑定空库的 host、port、库名、OID、PostgreSQL 启动时间与组合建表 SQL 的 SHA-256。换库或 PostgreSQL 重启后须重新生成计划。
- `apply PLAN.json`：在单事务中加锁校验目标库为空并原子执行全部 `01..04*.sql`，校验完整目录形态后写入 `public.v2_schema` 版本标记；失败自动回滚。
- `verify`：校验当前 Schema 版本标记、形态签名与文章当前发布坐标一致性。

> **Pre-release 策略说明**：FsusBlog v2 处于预发布阶段，所有表结构统一由 `plan` / `apply` 一次性初始化；不再维护零散的单表增量 schema 补丁命令（仅保留已停服运行的可选 `media-webp schema` 约束扩展与 `publication-transparency enable` 账本初始化）。V1 离线数据迁移工具已退役移除，切勿对 v1 数据库执行 `FsusBlog.V2.Cli`。

## 3. 密钥生成与账号/运维常用子命令

完整子命令清单可通过 `dotnet FsusBlog.V2.Cli.dll --help` 查看，核心运维操作如下：

| 子命令 | 作用 |
| --- | --- |
| `init-secrets` | 使用 CSPRNG 一次性生成三组独立 32 字节十六进制部署密钥（`FSUSBLOG_TOTP_KEY_HEX`、`FSUSBLOG_RECOVERY_KEY_PEPPER_HEX`、`FSUSBLOG_SUBSCRIPTION_HMAC_KEY`） |
| `admin-identity bootstrap HANDLE` | 创建统一管理员主体（集成全部创作与站点管理能力）并输出 10 分钟有效的一次性 Passkey 引导密钥 |
| `admin-identity rotate-passkey HANDLE` | 撤销管理员现有凭据与会话，签发替换 Passkey 引导密钥 |
| `admin-identity revoke-all HANDLE` / `disable HANDLE` | 强制结束管理员会话与待用邀请，或禁用主体并移除凭据 |
| `operator NAME [--reader]` / `ticket NAME` / `revoke NAME` | 创建普通读者账号（`blog_user`）并签发 10 分钟有效一次性首枚 Passkey 绑定票据；续发票据或吊销读者全部会话与未用票据 |
| `notify ACCOUNT_ID EVENT_ID` | 从 stdin 读取 UTF-8 JSON（`{"subject":"…","body":"…"}`），向指定启用账号幂等发送系统通知 |
| `comment handle` / `policy` / `moderate` | 为读者配置公开评论昵称、开关单篇文章评论投稿，或以可信数据库角色身份执行离线审核并记入审计 |
| `site-subscription issue-cancel rss\|email` | 从 stdin 读取邮箱并签发 15 分钟有效的一次性退订证明 |
| `article-public-media verify\|rebuild ...` | 核验公开文章历史图片对象，或从保留私有字节重建缺失的公开派生图片 |
| `publication-canonical verify` / `publication-transparency ...` | 重算规范发布摘要、初始化/核验透明日志以及签发发布与每日 Merkle 检查点 |
| `backup measure` / `extension --help` / `platform-plugin --help` | 离线站点备份指纹采集、签名扩展存储维护及纯 Markdown 离线插件执行 |

## 4. 数据库与私有媒体备份恢复

[`tools/site-backup.py`](../tools/site-backup.py) 生成并校验供离线恢复使用的 PostgreSQL 与私有媒体候选包：

1. 操作前停止在线服务与同库离线写进程，确保上传/删除完全结束；
2. 备份父目录与源媒体目录须为当前用户持有的绝对路径、`0700` 权限且互相隔离（无媒体时传独立空目录）；
3. 显式设置 `PGDATABASE`、`PGHOST`、`PGPORT` 并与 `FSUSBLOG_DB` 指向同一源库，使用同主版本 `pg_dump`；可通过 `FSUSBLOG_CLI_DLL` 和 `DOTNET_BIN` 定位已构建的 CLI。

```bash
python3 tools/site-backup.py capture "$private_backup_parent" "$new_candidate_name" "$source_media_root"
python3 tools/site-backup.py verify "$candidate" "$manifest_sha256"

# 仅恢复至新建的隔离空库与新建 0700 媒体目录
pg_restore --no-password --single-transaction --exit-on-error --no-owner --no-privileges \
  --dbname "$new_isolated_restore_db" "$candidate/database.dump"
FSUSBLOG_DB="$restore_dsn" python3 tools/site-backup.py verify-restored \
  "$candidate" "$manifest_sha256" "$isolated_restored_media_root"
```

- **校验机制**：备份期锁定数据库写者与媒体目录句柄（拒绝符号链接、硬链接与非私有权限），统计业务表、identity 序列与已提交媒体摘要，输出 `database.dump`、`media/` 与 `manifest.json` 并打印清单 SHA-256（需独立保管）。
- **安全与边界**：候选包包含明文数据库与媒体字节，须存于加密离线介质；完整生产恢复还需成对恢复外部部署密钥（如 `FSUSBLOG_TOTP_KEY_HEX`、签名私钥等）与反代配置。恢复后禁止并行对同一逻辑站点开放两个写端。

基础手工 `pg_dump` / `pg_restore` 核验模板：

```bash
umask 077
pg_dump --no-password --format=custom --dbname "$source_db" --file "$backup_file"
shasum -a 256 "$backup_file"
pg_restore --no-password --single-transaction --exit-on-error --dbname "$restore_db" "$backup_file"
FSUSBLOG_DB="$restore_dsn" "${cli[@]}" verify
```

## 5. 验证入口

使用专用测试 PostgreSQL 18 集群（配置 `FSUSBLOG_TEST_DB`、`PGHOST`、`PGPORT`、`PGUSER` 与受控 `PGPASSFILE`，脚本按次创建并清理随机临时数据库）：

```bash
bash tests/Integration/Migration/verify.sh
bash tests/Integration/Migration/backup-candidate.sh
```
