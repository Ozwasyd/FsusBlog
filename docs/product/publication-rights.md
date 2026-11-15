# 发布权利快照

文章作者可以在 FsusUI Inspector 保存完整的权利策略。新建草稿会显式保存 v1 仓库默认策略。已有草稿没有权利记录时，公开发布需要作者先保存策略。保留、复制和修改操作随草稿 CAS 事务写入，选择历史草稿恢复会保留其已有权利记录或缺失状态。保存权利和其他私有修订会清除锚定旧修订的定时发布。

即时和到期发布都为新公开坐标增加不可变快照绑定，与现行公开指针、沿革及 outbox 一次提交。公开详情的现有 ARD5/AEDS Rights V3 槽提供快照和修订坐标、许可证、权利人、年份、声明、署名模板和复制策略。公开前端和服务端 HTML 从已发布策略读取权利提示。缺失或错误绑定的文章在重建时退出同一个公开投影，因此详情、分布页、订阅源、站点地图和检索使用一致的准入范围。

`publication-rights` 为结构匹配的旧 v2 数据库添加权利存储并报告待补齐公开坐标。没有已保存的权利证据时，迁移保持该坐标但使其留在私有范围。作者确认策略并重新发布后产生新的证据。旧库审计候选保留来源凭证，但当前候选没有开放导入到运行库的发布权利提升操作。测试中的明确合成权利来自 `tests/Fixtures/publication-rights.sql`，单独记录摘要，不修改原代表性 seed。

此实现采用 v1 Rights V3 策略字段及固定记录布局。迁移验证与协议向量共用 `ArticleCanonicalHashesV1`。隔离候选只用保留的 v1 来源事实复算已有摘要，包括全局修订 ID、正数来源分类 ID、原始可空元数据和策略，以及经验证的历史发布时间或首发排期。两个冻结向量同时比对完整载荷和摘要。即时发布、带确切来源证据的再次发布及公开回滚、首发排期仍分别按迁移既有边界验证。 [共用规范](../../src/Contracts/ArticleCanonicalHashesV1.cs) · [冻结向量](../../tests/Protocol/fixtures/canonical-hash-golden-vectors.json)

原生 v2 只有文章内修订号，没有 v1 权利哈希所需的全局修订 ID。其可选分类和由正文生成的摘要也不能代替来源元数据。原生发布的 ARD5 详情中预留的 v1 哈希和证明字段保持空值。复制策略和 `ProofBindingEnabled` 按原样记录。公开 v2 签名单独提供。透明日志、责任历史包和浏览器复制增强仍待交付。 [v1 固定契约](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/docs/rights-v3-schema.md)

## 原生 v2 摘要与离线核验

从启用此结构后的第一笔原生发布起，作者发布或替换、排期到期、管理员公开回滚在各自原事务内记录规范摘要。行通过外键绑定实际发布沿革、不可变权利快照和本次写入的 `publish` outbox ID。之后的草稿、撤回和删除保持原记录。已存在的 v2 发布及从 v1 保留的来源记录不更新或补算。应用只追加记录，离线核验检查可信数据库中的一致性。

在 `FSUSBLOG_DB` 指定的现有 v2 库停服后运行 `publication-canonical schema`，无需重新发布既有文章。新库自动安装。运行 `publication-canonical verify` 可复算所有已绑定的摘要，附加一个发布 ID 可输出单条 JSON 收据。收据中的长整数用十进制字符串，发布时间保留 PostgreSQL 的六位微秒；第三方仍需用独立可信输入检验。该命令适用于只读连接。未绑定旧发布返回无可核验记录。公开 ARD5 布局及其证明字段保留原义。

规范内容载荷以 `fsusblog.integrity.article-content.v2` 开始，按源码固定行序编码文章 ID、文章内修订号、精确标题及正文 UTF-8、可空分类 ID 和正整数去重排序标签 ID。权利域 `fsusblog.integrity.article-policy.v2` 绑定该内容 SHA-256 及持久化策略字段，包括 `Enabled`、`ProofBindingEnabled`、空字符串和未设置年份的 `0`。各行由 LF 结束，字符串用标准 Base64，摘要用小写十六进制。正文包括原始组合字符和换行，派生摘要、可变标签名及独立媒体字节不在此 v2 载荷内。 [规范源码](../../src/Contracts/ArticleCanonicalHashesV2.cs) · [独立内容向量](../../tests/Protocol/fixtures/article-content-canonical-v2.txt) · [独立策略向量](../../tests/Protocol/fixtures/article-policy-canonical-v2.txt)

## 原生 v2 权利签名

此功能默认关闭。现有库先离线运行 `publication-proof schema`，并提供 `FSUSBLOG_PUBLIC_ORIGIN`。设置 `IntegrityProof__Signing__NativeV2Enabled=true` 和 `IntegrityProof__Signing__NativeV2PrivateKeyFile` 后，后台任务在现行公开快照和持久 outbox 都可验证时，绑定真实签发时间并追加 P-256/SHA-256 签名。签发要求已发布策略同时开启权利和证明绑定。处于草稿、已替换、已撤回或删除状态的坐标不提供公开证明。定时文章等实际发布后才有签发资格。

沿用 `IntegrityProof__Signing__CurrentKeyId` 及 `Keys` 公钥目录。每条记录提供正整数 `Version`、DER SPKI 的无填充 Base64URL `PublicKey`、`Algorithm=ECDSA_P256_SHA256` 和显式 UTC `NotBeforeUtc`、`NotAfterUtc`。当前私钥是同一公钥的 DER PKCS#8 文件，路径绝对、无符号链接，由服务 UID 持有，文件 `0400`，直接父目录 `0700`，远离前端目录、数据库和发布包。部署轮换使用新 ID，重启时保留旧 ID、公钥和时间窗口，只注入新私钥。`RevokedAtUtc` 排除该时刻及之后的签发，`CompromisedAtUtc` 排除该密钥的全部记录。旧键坐标和撤销状态在数据库保留，重启时拒绝换绑、删除或取消已记录的撤销。下载过的签名需用当前可信公钥和状态重新验证。

`GET /integrity/v2/keys.json` 和 `GET /integrity/v2/article/{articleId}/{publicationId}/rights.json` 仅在配置的 HTTPS 公共来源提供，使用 `no-store`。第一个返回当前验证公钥和完整时间窗，第二个返回可独立重建的签名字段。可用 `node tools/verify-publication-proof.mjs HTTPS_ORIGIN KEYS_JSON PROOF_JSON` 核验由可信来源获取的响应。签名绑定原生正文、规则、发布与 outbox 坐标及实际签发时间。签名不覆盖外观、分发 feed、附件独立字节或透明日志。 [签名字节](../../src/Contracts/ArticlePublicationProofV2.cs) · [独立验证器](../../tools/verify-publication-proof.mjs)

## 公开文章验签

公开文章为启用证明绑定的已发布权利策略提供 **Verify publication**。读者点击后，浏览器独立从当前详情帧中的标题、原始 Markdown、分类及标签 ID 和权利策略复算两份摘要，按固定字节顺序重建签名载荷，并从本站 HTTPS 来源即时读取公钥和签名收据。验证检查公开坐标、权利快照、密钥指纹、签发时间范围和撤销状态。最后再次读取收据，检查文章与证明仍可公开取得。成功后短暂显示核验时间和 JSON 收据链接，页面离开、切换标签或三十秒后清除结果。打开文章本身不发送证明请求。无签名、签名未就绪或已撤回的坐标显示不可用。

固定 v1 浏览器提供责任清单的公开链接和服务端材料状态。v2 文章页会对眼前这次发布执行本地签名比对。信任依据为当次同源公开密钥目录。部署中的 CDN 和 Service Worker 须直通 `/integrity/v2/`，避免重放旧的密钥状态和收据。历史责任清单、外部钥匙锚点及独立透明日志仍待交付。 [固定 v1 公开组件](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/frontend/src/components/article/ArticleResponsibilityDisclosure.vue#L68-L115)

使用 `FSUSBLOG_TEST_PUBLICATION_PROOF=1 tests/EndToEnd/run-admin-tls.sh` 可通过真实 Chrome、Caddy 和 PostgreSQL 核验签名、拒绝篡改的签名及已泄露的公钥状态、拒绝被替换或撤回文章的旧证明，并检查窄屏及切换标签时的状态清除。测试使用独立临时数据库、公钥和私钥。 [浏览器验收](../../tests/EndToEnd/publication-proof-flow.mjs)

## 原生签发日志

停止服务后，运行 `publication-transparency enable` 可为尚未签发任何原生证明的库开启本地签发日志。旧库可先运行 `publication-proof schema`。启用后数据库要求所有原生证明绑定准确的日志条目，重复启用为幂等操作。已有原生签名的库拒绝空起点启用，仍可继续提供这些收据。

启用后，每个准备完成的原生证明及其日志条目在同一 PostgreSQL 事务和写租约内落盘。每条记录使用整型连续序号，绑定上一条摘要及实际签名。收据摘要为 SHA-256，输入为以 NUL 结束的域名 `fsusblog.integrity.native-transparency-receipt.v2`、规范签名载荷的 SHA-256 和 64 字节 P1363 签名。日志摘要的输入为另一个以 NUL 结束的域名 `fsusblog.integrity.native-transparency-entry.v2`、八字节大端序号、前序摘要和收据摘要。第一条的前序摘要为 32 字节零。日志只保存签发坐标和摘要，草稿、正文、账号及责任清单资料留在各自存储中。 [规范代码](../../src/Contracts/PublicationTransparencyV2.cs)

`publication-transparency verify HTTPS_ORIGIN KEYS_JSON [PREFIX_SEQ PREFIX_SHA256]` 使用通过独立渠道保存的可信、最新原生 v2 公钥目录，在 PostgreSQL 只读快照内重建全链和每笔签名。恢复旧备份时使用当前密钥状态。把最新的非空输出序号及摘要另外存放，可作为后续核验的前序锚点，检出被改写的前缀或短于锚点的恢复库。锚点覆盖截至该序号的记录。例行换钥保留撤销时刻前已经签发的签名。数据库或提供的目录任一已知的泄露状态都排除该键的全部签名信任，日志仍保存原条目。命令通过时 `chainVerified` 为真，`trustStatus` 单独报告 `empty`、`trusted` 或 `withheld`，并统计正常退役、已撤销与已泄露签名。可另运行 `publication-canonical verify` 从保留的正文和策略复算签名所绑定的摘要。公开文章的现行证明继续由发布指针、权限、租约和公钥状态决定。

固定 v1 有产线权利证明追加器，证明与日志分两次提交。其公开 head 带历史文章坐标和原证明签名。固定源码的日检查点公开路由会读取已有记录，已定位的 Merkle 构建还用于独立审计，未定位到生产文章检查点写入器。 [固定 v1 追加流程](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/Integrity/IntegrityProofPipeline.cs#L292-L318) · [固定 v1 公开读取](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Infrastructure/Integrity/IntegrityVerificationManifest.cs#L452-L488)

## 可选公开日志头

新库包含日志头结构。已有日志库可停服运行 `publication-transparency head-schema`。签名和原生签发日志启用后，可通过 `IntegrityProof__Signing__NativeV2PublicHeadAnchor` 开放同源 HTTPS `GET /integrity/v2/log/head.json`。仅在首次启动且日志为空时使用 `genesis`，后续启动使用另行保留的正数序号和摘要 `SEQ:SHA256`。服务会核对锚点到当前日志头的连续摘要，并验证当时产生的原始日志头签名。锚点落后时，包含该锚点和有效签名头的旧备份仍可能回退到锚点之后的较早位置。需要更严格的恢复下限时，另行更新保留的锚点。

公开日志头只含站点来源、当前累计序号、摘要、证明时间、公钥坐标及该头本身的签名。公开后可观察到累计签发量和签发节奏。文章撤回或删除后，已有的聚合承诺仍保留，响应字段局限于该日志头。默认关闭，启用后日志为空时返回 404，无法验证已提交日志头或已经失去租约时返回 503。关闭公开投影时继续签发会使后续日志没有对应的公开签名，重新启用也不会替这些历史头补签。

`node tools/verify-publication-head.mjs HTTPS_ORIGIN KEYS_JSON HEAD_JSON` 使用当前可信的公钥目录独立比对 JSON 签名，并输出可另外保留的序号和摘要。单个签名只验证该次聚合承诺。可通过私有的 `publication-transparency verify` 核验两个锚点间的日志关系。 [独立验证器](../../tools/verify-publication-head.mjs)

`FSUSBLOG_TEST_PUBLICATION_HEAD=1 tests/EndToEnd/run-admin-tls.sh` 在独立 PostgreSQL 库启用空日志，通过真实 Caddy HTTPS 和匿名 Node 请求验签。它检查撤回前公开日志头与单篇证明都可核验，撤回后单篇地址返回 404 且聚合日志头字节保持一致。 [HTTPS 验收脚本](../../tests/EndToEnd/publication-proof-flow.mjs)

## 离线发布检查点

停止提供服务的进程后，用 `publication-transparency checkpoint-release HTTPS_ORIGIN KEYS_JSON HEAD_JSON RELEASE_ID FROM_SEQ TO_SEQ [INCLUDE_SEQ]` 签发一个本地 JSON 检查点。提供独立保留的原始签名日志头和最新可信公钥目录。工具在只读 PostgreSQL 快照内重算从所选区间起点到已见证日志头的连续摘要。区间最多 4,096 条，起点到日志头最多核验 16,384 条。发布标签由操作者指定。签名绑定标签和账本区间，发布包构建来源由其独立验收材料提供。

检查点使用停机服务中 `IntegrityProof__Signing__CurrentKeyId` 指定的有效密钥签名。该 ID 必须与可信目录的当前密钥相符。工具核对持久密钥指纹、发行窗口、退役和泄露状态，并从 `IntegrityProof__Signing__NativeV2PrivateKeyFile` 所指文件读取匹配的 DER PKCS#8 私钥。私钥文件需要放在公开服务目录之外，由执行用户持有且权限为 `0400`，直接上级目录为 `0700`。检查点使用 PostgreSQL 当前 UTC 时间。正常退役之前签发的旧日志头仍可作为锚点，任何已知泄露使受影响的签名失效。

树叶绑定序号和该次签发的不透明账本摘要，节点按序组合，奇数末项与自身配对。可选成员证明只返回所选序号、叶摘要和相邻摘要路径。使用 `node tools/verify-publication-checkpoint.mjs HTTPS_ORIGIN KEYS_JSON HEAD_JSON CHECKPOINT_JSON RELEASE_ID [SEQ ENTRY_SHA256]` 核验两个签名、预期发布标签、区间和路径。证明选中已见证的日志头序号时，工具自动核对叶摘要与该头的一致性。其他序号可提供独立保存的账本摘要。离线签发命令会重算私有账本的连续链。独立验证器核验签名者对树根与日志头关系的承诺，以及所提供的成员路径。文章当前可见性由公开文章证明独立确认。 [独立检查点验证器](../../tools/verify-publication-checkpoint.mjs)

## 离线 UTC 日检查点

同样在服务停止后，用 `publication-transparency checkpoint-daily HTTPS_ORIGIN KEYS_JSON HEAD_JSON YYYY-MM-DD [INCLUDE_SEQ]` 签发指定 UTC 日的本地检查点。提供的原始签名日志头必须签发于次日 UTC 零点或之后。工具在只读快照内验算从序号 1 到该头的全部链和原始签名收据载荷，并按收据中的原始签发时间选出该日 `[00:00, 次日 00:00)` 的条目。这个完整前缀最多 16,384 条，单日最多 4,096 条。超限、缺行、摘要不一致或所选成员不在该日时，命令失败且不输出检查点。

时钟回拨可能使同日条目在日志中不连续。日树按原始序号排列并保留间隔。可选成员证明只包含原始序号、在日树中的位置、不透明账本摘要和相邻摘要路径。若已认证前缀内该日没有条目，工具签发零计数和固定空树摘要。缺失结论仅覆盖该签名头所承诺的前缀，之后追加的条目仍可能带有该日时间戳。

使用 `node tools/verify-publication-checkpoint.mjs HTTPS_ORIGIN KEYS_JSON HEAD_JSON CHECKPOINT_JSON --daily YYYY-MM-DD [SEQ ENTRY_SHA256]` 独立核验日志头、日检查点签名及所给成员路径。日检查点使用独立签名域。验证器核对签名者对前缀覆盖范围的声明，私有账本重算由停机命令执行。成员关系只证明原收据已纳入账本，原收据签名的可信状态另由 `publication-transparency verify` 核验。目前只有离线人工签发。自动每日签发、公开检查点或成员证明、历史责任清单及独立时间见证仍待交付。 [规范代码](../../src/Contracts/PublicationCheckpointV2.cs)
