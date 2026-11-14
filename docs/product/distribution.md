# 公开分发

配置 `FSUSBLOG_PUBLIC_ORIGIN=https://blog.example.com` 后，公开 HTML 的 canonical 和订阅来源使用同一个 HTTPS origin。可指定端口。路径、凭据、查询和片段会使配置校验失败。生成链接不读取请求 Host 或代理转发头。

| 路由 | 格式 | 行为 |
| --- | --- | --- |
| `/feed/rss.xml`、`/api/Article/rss` | `application/rss+xml` | 两个 RSS 2.0 地址返回相同内容，订阅源自描述指向 `/feed/rss.xml`。 |
| `/feed/atom.xml` | `application/atom+xml` | Atom 1.0，文章 ID 与 canonical URL 一致。 |
| `/feed/feed.json` | `application/feed+json` | JSON Feed 1.1，保留数字字符串 ID，并以 `content_text` 提供摘要。 |
| `/sitemap.xml`、`/sitemap/{page}.xml` | `application/xml` | 45,000 个 URL 以内使用根 `urlset`，超过才输出根索引和从 1 开始的编号页。不存在的页返回 404。 |
| `/robots.txt` | `text/plain` | 已配置 origin 时列出正确 Sitemap，同时排除账户和内部 API 路径。 |

所有入口支持 GET 和 HEAD。订阅源按公开时间降序、文章 ID 降序发送最多 50 条，包含标题、摘要和时间。Sitemap 包含首页、归档、实际配置的说明/政策页、公开文章和关联至少一篇公开文章的分类及数字标签。旧标签名只用于 canonical 重定向。HTML 的 feed discovery 仅在公开可索引页面启用，说明页是否已配置由启动时同一份 `SitePages` 数据决定。SPA 切换路径时清除原首屏 canonical，新的直接 HTML 请求生成目标页 canonical。

RSS、Atom、JSON Feed、Sitemap 和 robots 随文章公开快照一次生成，成功响应带有同一个 `X-Fsus-Search-Index-Generation`。读取直接使用预编码文档。响应使用 `Cache-Control: no-store`，快照不可用或租约丢失时返回 503。撤回后的新请求使用当前一代快照，与该请求此前已经从网络下载的内容无关。没有配置 origin 时，robots 返回 200 和 `Disallow: /`，其他分发入口返回 503。JSON Feed 是标准分发文档，AEDS 业务 API 仍使用二进制协议。

参考提交 `2605b438eed8f16d12ddddf033d08a6fa18fcd12`。v1 注册了相同的 GET 路由、RSS 旧地址、50 条源上限和 45,000 URL 的 Sitemap 页大小。它使用 SEO 数据库配置、部署和旧工件回退来选 origin，还可输出封面元数据。v2 由同一份部署配置读取显式 origin、站点名称、描述、作者和版权归属。可编辑 SEO、封面字段、站点订阅/退订投递和完整性证明 sidecar 待接入。对空 Atom 源使用固定 UTC 时间以保留必要的 `updated` 字段。相关来源见 [公开站点配置](public-site-configuration.md)、[v1 路由](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/DistributionEndpoints.cs)、[分发服务](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Distribution/BlogDistributionService.cs)和[公开 HTML 组合](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs)。

v1 的匿名 `POST` 和 `DELETE /api/binary/subscriptions`（AEDS 157/158）只保存邮箱的带密钥哈希、渠道和启用状态。退订要求绑定同一哈希及渠道的一次性证明。默认无邮件或 Web Push 提供方，`email` 渠道只表达偏好。v2 当前通过 RSS、Atom 和 JSON Feed 分发文章。 [v1 订阅入口](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Subscriptions.cs) · [v1 订阅安全契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/security.md)
