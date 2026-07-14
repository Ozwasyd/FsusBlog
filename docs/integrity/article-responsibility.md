# 文章责任、来源与修订公开说明

文章发布时可以为每个 revision 保存一份 `article_responsibility_snapshot`。它是责任与证据披露，不是搜索排名评分，也不计算关键词密度、字数、E-E-A-T 或 GEO 分数。

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

`verification.proofStatus` 只输出 `ready`、`failed` 或 `unavailable`，不泄漏失败详情、后台 principal、草稿、审计上下文或密钥。旧文章没有责任快照时，输出确定性的站点作者继承结果并标记 `legacyFallback=true`，不会根据请求时间生成随机或临时内容。

## 迁移

新表由 schema CodeFirst 管理。历史文章无需阻塞迁移；它们先使用 legacy fallback。下一次实质修订时写入完整 snapshot。若需要批量补录，应以已有 revision id 为键创建快照，不得改写历史 revision 或伪造 reviewer/source。
