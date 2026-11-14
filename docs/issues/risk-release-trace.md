# 发布、分发和身份恢复的实现对照

本批从 `92e6464` 的冻结评论与 v1 `2605b438eed8f16d12ddddf033d08a6fa18fcd12` 固定源码核对。v2 结果绑定各表中明确记录的提交。未提交路径为静态观察。相关数据库和浏览器证据使用原运行记录，本批未重跑产品测试。

| 范围 | 已核对结果 |
| --- | --- |
| 预约、历史和权利 | 发布/撤回有实际 PostgreSQL 事务，公开读按活动发布及其修订取值。当前活动发布行采用 upsert 或删除，完整历史没有持久保全。ARD5 的固定 rights record 尚为空，相关 Rights V3 和责任链仅进入 v1 离线影子演练。工作树已有基础授权历史和草稿回滚。预约、旧发布保留到实际到期、完整对照及带权利快照的新发布回滚仍缺。 [发布条款](risk-publication.tsv) · [固定 v1 发布与修订合同](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/api/article-publication-revisions.md) |
| 分发和透明度 | RSS、旧 RSS 别名、Atom、JSON Feed、Sitemap 与 robots 属固定 v1 产品路由。审阅时新增分发代码在工作树，需用真实候选运行核验。订阅的 AEDS 注册/退订、签名发布证明、附加型透明日志和后台重试分别缺实现证据。 [分发条款](risk-distribution.tsv) · [固定 v1 HTTP 契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/api/contracts.md#L2236) |
| 普通身份、后台主体与恢复 | 运维票据、Passkey、普通账号 TOTP、一次性二次认证恢复码的证据按入口区分。v1 单独的 Recovery Key 恢复、设备 enrollment、后台主体及后台票据和独立 cookie/权限仍按各来源核查。 [恢复与隔离条款](risk-identity-recovery.tsv) |

[历史评论对应关系](historical-comment-lineage.tsv) 记录 99 组现有记录与其来源正文逐字节相同，以及 613 条原先按明确历史标记归类的评论。后者的定位片段和摘要绑定冻结原文。#3729 的 389 条记录包括编号包和后续片段。对应关系仅能证明历史分类的原文来源与相同正文，未对包完整性、旧候选的测试结果或所有条款的语义作新增认证。

这些条款仍保留在完整 P0 的未完成范围。剩余的自由文本和跨域依赖、未裁定产品契约、真实候选的业务测试分别记录。
