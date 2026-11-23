# 管理员分类与标签管理

> **角色**：功能契约
> **适用对象**：站点管理员与维护者
> **权威依据**：分类与标签管理接口以 `src/Server/Identity/AdminTaxonomy*.cs`、`AdminTagMetadata*.cs` 与 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs) 为准。

## 1. 启用前提与权限边界

- 配置合法管理员源（默认单域名 HTTPS、独立 HTTPS 管理源或本机 Loopback 管理源）后，`FSUSBLOG_ADMIN_CATEGORY_METADATA` 与 `FSUSBLOG_ADMIN_TAG_METADATA` 均默认自动开启（可分别显式设为 `false` 静默关闭）。
- 所需表结构随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化。
- 权限沿用统一管理员身份模型（不再区分 `article.write` / `admin.manage` 子权限）：登录后的管理员可在 `/admin/articles` 的「分类」与「标签」标签页及文章编辑器侧边栏管理分类与标签；普通读者会话访问一律返回 `401`。

## 2. 目录读取与引用依赖检查

- **目录分页**：`GET /api/v2/admin/identity/taxonomy/categories.aeds` 与 `GET /api/v2/admin/identity/taxonomy/tags.aeds` 返回 AEDS `32864`（`Cache-Control: no-store`），按 ID 升序每页最多 24 项，支持 `after` 游标续页。
- **状态统计**：公开数量来自带权利快照验证的当前发布投影并核对同次查询发布水位（投影不可用返回 `503`）；草稿、排期、撤回与软删除按文章当前修订统计；保留文章数按任意保留修订去重统计。
- **引用依赖查询**：上述两条目录路径附带 `?dependency=ID` 返回 AEDS `33070`（4 个小端 Int32：ID、活跃引用文章数、仅保留引用文章数、已保留标签别名数）。该结果仅反映当次读取事实，实际删除仍受数据库外键与并发写入约束。

## 3. 分类创建、编辑与删除

- **端点与帧**：
  - `POST /api/v2/admin/identity/taxonomy/categories/create.aeds`（AEDS `33058` → `33059`，创建时固定零 ID 与零修订）
  - `GET` / `PUT /api/v2/admin/identity/taxonomy/categories/{id}/metadata.aeds`（读取与编辑元数据，校验期望修订 CAS）
  - `POST /api/v2/admin/identity/taxonomy/categories/{id}/delete.aeds`（物理删除无任何修订引用的分类；仍存在历史或当前修订引用时返回 `409`）
- **约束与防重放**：各写入前需在同管理源调用对应 `pow.aeds` 签发绑定当前会话、请求帧、目标与来源的证明；名称去除首尾空白并保留大小写（≤ 128 UTF-8 字节，不生成别名），描述最多 500 个 Unicode 标量。

## 4. 标签创建、编辑、历史别名与删除

- **端点与帧**：
  - `POST /api/v2/admin/identity/taxonomy/tags/create.aeds`（AEDS `33060` → `32945`，搭配 `tags/create/pow.aeds`）
  - `GET` / `PUT /api/v2/admin/identity/taxonomy/tags/{id}/metadata.aeds`（AEDS `32944` → `32945`，搭配 `tags/{id}/metadata/pow.aeds`）
  - `POST /api/v2/admin/identity/taxonomy/tags/{id}/delete.aeds`（物理删除无任何已保存修订引用的标签，同时清理保留别名与元数据命令审计；仍有引用返回 `409`）
- **名称与别名规则**：名称去除首尾空白并按 NFC 规范化（≤ 128 UTF-8 字节），拒绝 ASCII 纯数字与路径分隔符；描述最多 500 个 Unicode 标量。改名时稳定数字 ID 不变，历史名称在同一事务保留并使旧链接单跳 `301` 重定向至数字页（保留查询参数）；跨标签重用活跃名或历史别名返回冲突。

## 5. 公开快照联动（`taxonomy_epoch`）

分类与标签共享持久 `taxonomy_epoch`：发生实质变更时在同一 PostgreSQL 事务内提交元数据、幂等审计回执并递增 `taxonomy_epoch`，与文章 outbox 水位共同触发 `PublicSnapshot` 重建（无文章引用的分类/标签或仅描述变更亦可即时刷新公开页面与旧链接；空操作与幂等重试不递增代次）。关闭管理编辑开关后仍保留读取已提交 `taxonomy_epoch`。
