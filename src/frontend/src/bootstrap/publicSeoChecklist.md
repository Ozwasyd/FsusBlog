# Public SEO Checklist

- [x] 首访公共页允许服务端 AOT shell 先显示，再延迟接管 Vue SPA
- [x] About 页纳入公开页范围
- [x] About 页首访明确走 server-first AOT 公开页链路，SPA 仅负责后续接管
- [x] Home / ArticleDetail / Filter(category/tag) / About / Archive 的首访 AOT 直出已收口到后端统一首访链路与缓存壳注入
- [x] `FilterView` 保持统一渲染；`search` 不参加公开页首访 AOT，只走普通 SPA 首访
- [x] `Archive` 已纳入公开页 AOT 主链，不再作为 SPA 兜底页面
- [x] 管理端文章发布、修改、删除后只失效 AOT；下一次公开页访问返回 SPA 并触发服务端异步 backfill
- [x] ArticleDetail 在 SPA 接管后，再按需注入评论区交互
- [x] 评论区 AOT 占位符与 SPA 评论流插入策略对齐
