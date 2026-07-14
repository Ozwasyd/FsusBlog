# Issue #1085：公共路由真实状态门禁

## 目标契约

公共 HTML 的首个服务器响应是状态真相源。Vue Router 只负责已成功加载应用后的客户端导航，不得把服务器 404 改造成“先 200、挂载后再显示 404”。

状态分类：

- `Success`：有效公开实体；允许 fresh AOT 命中，cold miss 允许排队 backfill 并返回现有 SPA fallback。
- `NotFound`：无效路径、不存在实体、未发布、定时未到、归档、删除或 rights snapshot 不完整；返回 404。
- `Gone`：仅为未来明确、不可恢复的永久删除状态保留；当前数据模型不推断 410。
- `TransientFailure`：provider、DB gate 或基础设施暂时失败；返回 503 + `Retry-After: 5`。

404/410/503 使用无脚本 noindex HTML，不输出 canonical、Open Graph URL、`BlogPosting`、bootstrap 或 hydration payload，也不排队/写入普通 Public AOT cache。除根路径外，尾斜杠以 301 规范到无尾斜杠 path。

## 自动化覆盖

- backend identity/registry：正整数、有效 tag slug、零值、额外 segment、尾斜杠和非法 percent encoding。
- backend shell：cold miss 的 success/not-found/transient 分类；失败不调度 backfill。
- backend composition：GET/HEAD 404 同状态、noindex、无成功 metadata/脚本；503 Retry-After；尾斜杠保留 query 的 301。
- production SEO smoke 与 Playwright acceptance：unknown、article/category/tag 零值与不存在实体、三类额外 segment、GET/HEAD parity、no backfill、无 hydration、单跳尾斜杠 redirect。
- provider contract：文章公开投影继续约束 `IsDeleted=false`、`Published`、实际发布时间和定时发布时间；不存在 taxonomy 不再构造成功空列表。

## 边界场景

- 匿名公共请求：按上述状态矩阵执行，并继续经过 `public_read` limiter 与风险过滤器。
- 登录请求与 admin 请求：公共 HTML 状态不读取 principal；`/user/**` 仍是已登记 SPA 工作区，不受 SEO 404 分类影响。
- notification stream：路由和握手契约未修改。
- binary API：AEDS frame、`X-Fsus-*` 安全头和 binary NotFound 语义未修改。

## 风险、降级与回退

风险集中在 cold miss 多一次 provider read，以及过严 path 校验拒绝历史非规范 URL。fresh AOT 热路径不增加数据库读取；尾斜杠保留单跳兼容。运行时无需重启的降级路径是保留 fresh artifact、暂停新 backfill，并让临时 provider 故障明确返回可重试 503；不得通过恢复“所有 fallback 都返回 200”来降级。若需代码回退，应整体回退 classified miss 与 status writer，不能只移除测试或 noindex 头造成半套语义。
