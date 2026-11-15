# 发布权利快照

文章作者可以在 FsusUI Inspector 保存完整的权利策略。新建草稿会显式保存 v1 仓库默认策略。已有草稿没有权利记录时，公开发布需要作者先保存策略。保留、复制和修改操作随草稿 CAS 事务写入，选择历史草稿恢复会保留其已有权利记录或缺失状态。保存权利和其他私有修订会清除锚定旧修订的定时发布。

即时和到期发布都为新公开坐标增加不可变快照绑定，与现行公开指针、沿革及 outbox 一次提交。公开详情的现有 ARD5/AEDS Rights V3 槽提供快照和修订坐标、许可证、权利人、年份、声明、署名模板和复制策略。公开前端和服务端 HTML 从已发布策略读取权利提示。缺失或错误绑定的文章在重建时退出同一个公开投影，因此详情、分布页、订阅源、站点地图和检索使用一致的准入范围。

`publication-rights` 为结构匹配的旧 v2 数据库添加权利存储并报告待补齐公开坐标。没有已保存的权利证据时，迁移保持该坐标但使其留在私有范围。作者确认策略并重新发布后产生新的证据。旧库审计候选保留来源凭证，但当前候选没有开放导入到运行库的发布权利提升操作。测试中的明确合成权利来自 `tests/Fixtures/publication-rights.sql`，单独记录摘要，不修改原代表性 seed。

此实现采用 v1 Rights V3 策略字段及固定记录布局。迁移验证与协议向量共用 `ArticleCanonicalHashesV1`。隔离候选只用保留的 v1 来源事实复算已有摘要，包括全局修订 ID、正数来源分类 ID、原始可空元数据和策略，以及经验证的历史发布时间或首发排期。两个冻结向量同时比对完整载荷和摘要。即时发布、带确切来源证据的再次发布及公开回滚、首发排期仍分别按迁移既有边界验证。 [共用规范](../../src/Contracts/ArticleCanonicalHashesV1.cs) · [冻结向量](../../tests/Protocol/fixtures/canonical-hash-golden-vectors.json)

原生 v2 只有文章内修订号，没有 v1 权利哈希所需的全局修订 ID。其可选分类和由正文生成的摘要也不能代替来源元数据。原生发布的公开记录中规范哈希及证明字段仍为空。复制策略和 `ProofBindingEnabled` 按原样记录。公开 v2 签名单独提供。透明日志、责任历史包和浏览器复制增强仍待交付。 [v1 固定契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/rights-v3-schema.md)

## 原生 v2 摘要与离线核验

从启用此结构后的第一笔原生发布起，作者发布或替换、排期到期、管理员公开回滚在各自原事务内记录规范摘要。行通过外键绑定实际发布沿革、不可变权利快照和本次写入的 `publish` outbox ID。之后的草稿、撤回和删除保持原记录。已存在的 v2 发布及从 v1 保留的来源记录不更新或补算。应用只追加记录，离线核验检查可信数据库中的一致性。

在 `FSUSBLOG_DB` 指定的现有 v2 库停服后运行 `publication-canonical schema`，无需重新发布既有文章。新库自动安装。运行 `publication-canonical verify` 可复算所有已绑定的摘要，附加一个发布 ID 可输出单条 JSON 收据。收据中的长整数用十进制字符串，发布时间保留 PostgreSQL 的六位微秒；第三方仍需用独立可信输入检验。该命令适用于只读连接。未绑定旧发布返回无可核验记录。公开 ARD5 布局及其证明字段保留原义。

规范内容载荷以 `fsusblog.integrity.article-content.v2` 开始，按源码固定行序编码文章 ID、文章内修订号、精确标题及正文 UTF-8、可空分类 ID 和正整数去重排序标签 ID。权利域 `fsusblog.integrity.article-policy.v2` 绑定该内容 SHA-256 及持久化策略字段，包括 `Enabled`、`ProofBindingEnabled`、空字符串和未设置年份的 `0`。各行由 LF 结束，字符串用标准 Base64，摘要用小写十六进制。正文包括原始组合字符和换行，派生摘要、可变标签名及独立媒体字节不在此 v2 载荷内。 [规范源码](../../src/Contracts/ArticleCanonicalHashesV2.cs) · [独立内容向量](../../tests/Protocol/fixtures/article-content-canonical-v2.txt) · [独立策略向量](../../tests/Protocol/fixtures/article-policy-canonical-v2.txt)

## 原生 v2 权利签名

此功能默认关闭。现有库先离线运行 `publication-proof schema`，并提供 `FSUSBLOG_PUBLIC_ORIGIN`。设置 `IntegrityProof__Signing__NativeV2Enabled=true` 和 `IntegrityProof__Signing__NativeV2PrivateKeyFile` 后，后台任务在现行公开快照和持久 outbox 都可验证时，绑定真实签发时间并追加 P-256/SHA-256 签名。签发要求已发布策略同时开启权利和证明绑定。处于草稿、已替换、已撤回或删除状态的坐标不提供公开证明。定时文章等实际发布后才有签发资格。

沿用 `IntegrityProof__Signing__CurrentKeyId` 及 `Keys` 公钥目录。每条记录提供正整数 `Version`、DER SPKI 的无填充 Base64URL `PublicKey`、`Algorithm=ECDSA_P256_SHA256` 和显式 UTC `NotBeforeUtc`、`NotAfterUtc`。当前私钥是同一公钥的 DER PKCS#8 文件，路径绝对、无符号链接，由服务 UID 持有，文件 `0400`，直接父目录 `0700`，远离前端目录、数据库和发布包。部署轮换使用新 ID，重启时保留旧 ID、公钥和时间窗口，只注入新私钥。`RevokedAtUtc` 排除该时刻及之后的签发，`CompromisedAtUtc` 排除该密钥的全部记录。旧键坐标和撤销状态在数据库保留，重启时拒绝换绑、删除或取消已记录的撤销。下载过的签名需用当前可信公钥和状态重新验证。

`GET /integrity/v2/keys.json` 和 `GET /integrity/v2/article/{articleId}/{publicationId}/rights.json` 仅在配置的 HTTPS 公共来源提供，使用 `no-store`。第一个返回当前验证公钥和完整时间窗，第二个返回可独立重建的签名字段。可用 `node tools/verify-publication-proof.mjs HTTPS_ORIGIN KEYS_JSON PROOF_JSON` 核验由可信来源获取的响应。签名绑定原生正文、规则、发布与 outbox 坐标及实际签发时间。签名不覆盖外观、分发 feed、附件独立字节或透明日志。 [签名字节](../../src/Contracts/ArticlePublicationProofV2.cs) · [独立验证器](../../tools/verify-publication-proof.mjs)
