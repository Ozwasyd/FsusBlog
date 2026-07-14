# Issue #1087：标签 URL 单一身份

## 决策

采用稳定 ID canonical：`/tag/{id}` 是唯一可返回 200、进入 sitemap、AOT manifest、内部链接、navigation snapshot、canonical、Open Graph 与 JSON-LD 的标签 URL。显示名称不承担长期 URL 身份。

历史 `/tag/{name}` 只作兼容入口。服务端对 percent-decoded 单段名称执行 trim、Unicode NFC 与 invariant case lookup；当前名称或 `tag_url_alias` 唯一命中后返回单跳 301 到 `/tag/{id}`，并保留 query。不存在、非法或歧义名称返回 404，不跳首页。

## 重命名与迁移

`PUT /api/binary/tag/{id}` 在原有 admin permission、PoW、审计、投影 outbox 与 cache invalidation 边界内，把旧名称的规范化 lookup key 与原始显示名写入受管表 `tag_url_alias`，再更新 `Tag.Name`。旧名称、新名称、大小写变体和 NFC 等价 Unicode 因而都指向同一稳定 ID；旧名称不得被其他标签复用。删除标签后 alias 不会指向其它实体，解析 join 不到活动标签时返回 404。

## 自动化覆盖

- backend identity：ID canonical、tag-name 不 self-canonical、Unicode NFC/case lookup。
- backend shell：name route 在 cache/backfill 前分类为 permanent redirect；navigation snapshot 输出 `tag:{id}` 与 `/tag/{id}`。
- backend manifest：只生成 tag ID route。
- schema integration：重命名事务写入旧名称 alias，同时保留 taxonomy projection outbox。
- frontend unit/static：文章列表与详情标签链接使用 tag ID；name hydration 成功页断言被替换为单跳 redirect 断言。
- SEO smoke / Playwright：ID URL 为成功页，当前名称 URL 301 单跳到同一 ID；不存在名称仍为 404。

## 边界、风险与回退

- 匿名公共请求：名称兼容解析会读 taxonomy/alias；ID AOT 热路径不增加数据库读取。
- 登录/admin：公开 redirect 不读取 principal；标签重命名继续使用既有 admin permission、PoW 与审计。
- notification stream 与 binary AEDS payload：wire、frame、`X-Fsus-*` 安全头均未改变。
- 无需重启降级：可在入口层暂停 name alias 流量，并在管理端暂停标签重命名写入；现有 `/tag/{id}`、sitemap 与 AOT artifact 继续工作。恢复时直接重新放行流量，无需清理 alias；不得恢复 name 200 self-canonical。数据库 alias 表由受管 CodeFirst schema 创建，属于对现有 `tag` 数据无破坏的附加结构。
