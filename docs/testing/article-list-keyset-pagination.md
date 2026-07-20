# 公共文章列表 Keyset 验证

公共文章列表按 `createtime DESC, id DESC` 排序。首屏不带 cursor；后续请求必须原样回传上一帧的 `nextCursor`。cursor 是版本化 opaque base64url 值，绑定分类、标签与规范化关键词；客户端不得解析或跨过滤条件复用。

## 正确性门禁

本地 PostgreSQL 场景由 `ArticleListKeysetPaginationIntegrationTests` 覆盖：

- fixture 为相同 `createtime` 生成多个 ID，验证复合排序不会丢行；
- 分类、标签与关键词同时过滤；
- 读取首屏后插入一条更晚记录，再沿 cursor 读完，断言首屏边界内的原始记录无重复、无跳过；
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 必须使用有序索引路径，且计划不含 `Sort` 或 `OFFSET`。

运行 focused 门禁：

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --filter "FullyQualifiedName~ArticleListKeysetPaginationIntegrationTests"
```

测试只启动临时本地 PostgreSQL 容器，不访问生产数据库、真实流量或外部压测平台。性能结果只用于当前固定 fixture 的查询形状回归，不作为生产延迟承诺。

## 兼容与回退

旧 page URL 继续可用；没有 cursor 的深页在服务端按 keyset window 顺序推进，不执行公共列表 `OFFSET`。预生成首屏/page artifact 会发出新版 cursor，浏览器拿到后优先使用 cursor。

如需无重启降级，客户端可暂时停止发送 `cursor` 并继续请求原 page URL；管理端列表始终保留 page/offset。frame cache 使用 `core:v5` cursor identity，源列表 cache 使用 `v2` 前缀，因此旧 envelope/cache 不会被新版读链误用。
