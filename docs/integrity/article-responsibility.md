# 文章责任、来源与修订公开说明

文章的每个 revision 可以保存 append-only 的 `article_responsibility_snapshot` 版本链。每次保存以 `expectedVersion` CAS 追加新版本并记录 `previousSnapshotId`，不会覆盖旧快照。它是责任与证据披露，不是搜索排名评分，也不计算关键词密度、字数、E-E-A-T 或 GEO 分数。

## 作者继承与多人作者

- 单作者站点可设置 `inheritSiteAuthor=true`；公开 manifest 会继承站点配置的作者名。
- 多作者文章应填写有序 `authors` 数组，每项包含展示名和可选的稳定公开 profile URL。
- reviewer 可省略；存在时与作者分开显示。
- AI 可以辅助写作，但 `responsiblePersonConfirmed` 必须由实际责任人确认。该确认不公开后台账号或 actor id。

## 来源与修订说明

`sources` 是结构化数组：标题、公开 URL、来源类型、访问日期、版本和可选引用说明。仅 `http`/`https` 且不含 URL user-info 的公开链接会进入 manifest；私有来源不会公开。

实质更新应填写：改了什么、为什么修改、生效时间，以及结论影响 `none | clarified | changed | unknown`。研究、测评等内容可按类型启用 methodology、applicability 和 limitations，普通随笔无需套用研究模板。

## 公开核验与失败状态

- 当前 revision：`GET /integrity/article/{articleId}/responsibility`
- 指定 revision：`GET /integrity/article/{articleId}/revisions/{revisionNo}/responsibility`
- proof 原文：manifest 的 `verification.url`

`verification.proofStatus` 只输出 `ready`、`failed` 或 `unavailable`，不泄漏失败详情、后台 principal、草稿、审计上下文或密钥。旧文章没有责任快照时，输出确定性的站点作者继承结果并标记 `legacyFallback=true`，不会根据请求时间生成随机或临时内容。早于 revision 表的公开旧文章在 current 端点中使用 `revisionNo=0`、`proofStatus=unavailable` 和当前文章 proof URL；指定不存在的历史 revision 仍返回 404。

公开 current sidecar 读取 `current_publication_id` 显式引用的责任快照；历史 sidecar 读取该 revision 对应 publication 的显式快照。因此后续责任修订不会改写旧 publication 的证据。已发布当前 revision 的责任保存会新建 publication，并通过同事务 `responsibility-updated` outbox 更新 AOT、AEDS、cache 与 notification。管理端可用 `GET /api/binary/author/articles/{articleId}/revisions/{revisionId}/responsibility` 读取全部版本；PUT 的 stale `expectedVersion` 返回 409。

## 迁移

迁移为已有快照回填 `responsibilityVersion=1`，并回填 publication/outbox 的显式快照指针；重复执行保持幂等。历史文章没有快照时继续使用 legacy fallback。若需要批量补录，应以已有 revision id 为键追加快照，不得改写历史 revision 或伪造 reviewer/source。迁移验收边界为本地 PostgreSQL 单进程，schema 与代码必须原子切换。
