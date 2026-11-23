# 公开文章图片发布

> **角色**：功能契约
> **适用对象**：站点部署者、创作者与后端维护者
> **权威依据**：目录发现与能力解析以 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs) 为准；端点与事务以 `src/Server/Content/PublishedMediaEndpoints.cs` 与 `src/Cli/Schema/02-authoring.sql` 为准。

## 1. 启用前提与目录隔离

- 配置 `FSUSBLOG_DATA_DIR` 后，服务端自动在其中初始化 `0700` 权限的 `private-media/` 与 `public-media/` 并启用公开文章图片能力；也可通过绝对路径 `FSUSBLOG_PRIVATE_MEDIA_ROOT` 与 `FSUSBLOG_PUBLIC_MEDIA_ROOT` 单独覆盖（均须与 Web 静态目录、外观目录及彼此互斥，由服务用户独占持有；显式设 `FSUSBLOG_PUBLIC_MEDIA_ROOT=""` 可单独关闭公开图片）。
- 所有公开图片与封面表结构均随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化。

## 2. 显式选择、封面与发布事务

- **显式授权公开**：在编辑器私有附件检查器中，作者可从当前已保存修订的私有图片中显式勾选最多 **32 张**随本次发布公开（也可将其中一张草稿封面纳入公开选图）。默认勾选集为空；普通发布、定时发布、历史恢复与管理员回滚不会隐式公开未选中的私有附件。
- **格式与配额**：仅接受已规范化的 PNG、JPEG 或（启用 WebP 约束后的）静态 WebP；单张上限 20 MiB，单次发布合计上限 40 MiB。
- **原子事务与幂等**：服务端校验作者所有权、`ready` 状态、已存 SHA-256 及大小限制后，以内容 SHA-256 命名经目录描述符排他原子落盘至公开对象根，并在同一 PostgreSQL 事务中提交新修订、发布坐标、不可变公开图片清单 `article_publication_media`、幂等命令回执与 outbox 事件。同命令键与同输入可安全重放，修改资产集合或修订返回 `409`。
- **撤回与恢复语义**：撤回文章后原公开图片与封面 URL 立即失效（已传输或已下载至客户端的副本无法远程擦除）；管理员从回收站恢复历史公开版本时，仅恢复前次已显式获准公开的图片与封面角色。

## 3. 公开读取、限流与防缓存泄漏

- **公开坐标**：清单路径 `/api/v2/public/articles/{articleId}/{publicationId}/media.aeds`，文件对象路径 `/public-media/{articleId}/{publicationId}/{sha256}`；不暴露内部私有资产 UUID、原始文件名或磁盘路径。
- **热快照一致性**：`PublicSnapshot` 在一致性视图中批量加载当前公开文章的图片元数据；文章列表/详情热读不增加额外数据库或磁盘查询。
- **文件交付与限流**：文件端点仅接受 `GET` / `HEAD`（`Range` 返回 `416`，其他方法返回 `405`），先校验限流与当前 `PublicSnapshot` 授权，再读取完整有界对象核对长度与 SHA-256，发送前再次复核快照与租约，输出标准图片 MIME、`X-Content-Type-Options: nosniff` 与 `Cache-Control: no-store`（不返回延长旧对象生命的 `304`）。
  - 直连/兜底限流：每 IP 每分钟 600 次，最多 4 个已准入响应同时持有缓冲；
  - 可信回环代理模式：按单跳转发真实 IP 实施每 IP 10 次/秒 + 突发 30 准入（超限返回 `429` + `Retry-After`），长 GET 首送 1 MiB 后按最高 8 MiB/s 逐段流式发送。

## 4. 离线核验与重建及验证入口

公开对象缺失时可经离线 CLI 从受保护私有原件核验或重建：

```bash
dotnet FsusBlog.V2.Cli.dll article-public-media verify SITE_UUID PRIVATE_ROOT PUBLIC_ROOT WEB_ROOT
dotnet FsusBlog.V2.Cli.dll article-public-media rebuild SITE_UUID PRIVATE_ROOT PUBLIC_ROOT WEB_ROOT
```

端到端浏览器验证：

```bash
FSUSBLOG_TEST_FLOW=public-article-media bash tests/EndToEnd/run-native.sh
```
