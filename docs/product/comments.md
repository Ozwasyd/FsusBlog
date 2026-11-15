# 公开评论读取

文章页支持评论主列表、直接回复、分支分页和评论永久链接。回复分支只展示直接子节点，永久链接展示目标、祖先和相邻节点，并把键盘焦点移到目标。评论正文使用纯文本渲染。

当前服务保留 AEDS v2 评论读路径 `GET /api/binary/comment/{articleId}`、`/{articleId}/children/{parentId}`、`/{articleId}/context/{commentId}`、`/{articleId}/thread/{rootId}`。根节点按 ID 降序，子节点和旧 thread 端点按 ID 升序。评论 ID 经过 64 位二进制字段传输，浏览器以十进制字符串保存。

PostgreSQL 查询要求文章当前发布且评论已审核。必要祖先可以作为脱敏占位节点显示，作者名、正文和非必要回复目标均不从未批准分支公开。未知地区按保守规则隐藏任意地区已有屏蔽的内容。缺失、隐藏、删除、地区屏蔽或越权目标的永久链接返回同一不可用响应。响应禁用缓存，返回前再次核对当前公开快照。

受控评论投稿默认关闭。管理员可设置 `FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS=true`，通过维护工具 `comment policy ARTICLE_ID enable` 开放指定文章，再用 `comment handle ACCOUNT_ID DISPLAY_NAME` 为现有已启用账户配置明确公开的显示名。文章页只向符合条件的当前会话显示表单，提交者确认显示名和发布坐标后可发送顶层评论。正文限制为 1000 个 UTF-16 单元和 4096 个 UTF-8 字节，在审核前不会进入公开查询。重复请求由账号、命令键和请求指纹共同识别，成功写入和幂等记录在同一事务内提交。

启用投稿后必须完成 classic PoW。客户端以原投稿的 AEDS 帧请求 `POST /api/v2/comments/pow-challenge.aeds`，收到 v1 的 204 字节 PowChallenge (30) 载荷，再在可取消的 Worker 中求解并用 `X-Fsus-Pow-Proof` 发送 FPOW v1 证明。12 bit 难度适用于此专用入口。浏览器每次生成随机 nonce，不采集浏览器指纹。挑战有效期 120 秒，绑定会话、经过可信代理处理的地址、随机 nonce 和投稿帧。每 60 秒每会话最多签发 8 次，同一来源最多 24 次，服务端另有并发上限。使用 Worker 避免阻塞界面，超时或离开文章时停止计算。

验证后的签名只在 PostgreSQL 事务内消费一次。评论写入回滚时消费一同回滚。请求结果丢失时，原命令键可以携新签发的证明取回同一待审结果。服务重启会使此前签发的挑战到期。共用验证器的签名边界包含固定动作和服务端提供的资源坐标，其他动作必须分别完成签发准入和业务授权。旧匿名通用挑战入口和风险聚合仍待实现。

持有 `comment.moderate` 的独立管理员可在管理主机读取待审核队列。公开评论接口仍只返回已批准的正文。 [管理员权限与队列](admin-identity.md)

有维护数据库写权限的操作员可使用 `comment moderate ARTICLE_ID COMMENT_ID EXPECTED_STATUS approve|reject|hide REASON`。命令在一个语句内检查前态、更新状态并记录前后状态、当前数据库角色、理由与时间。数据库角色标识本次操作，共用凭据无法提供个人归因。

投稿使用独立的 v2 授权与提交端点。v1 完整评论策略、动态风险策略和复合证明、匿名证明和生产评论迁移仍有缺口。原生 PostgreSQL 集成在独立临时数据库中验证四个读端点、跨文章与撤回可见性，以及并发投稿重试、授权拒绝和待审隔离。

### 登录账号回复与站内通知

登录回复默认关闭。旧部署停机执行 `comment replies-schema`，再同时启用 `FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS=true` 与 `FSUSBLOG_SIGNED_IN_COMMENT_REPLIES=true`。已允许投稿的账号可以从公开文章的评论选择「Reply」，确认实际公开显示名，向当前可见的父评论发送待审回复。切换目标、取消或账号变化会清空草稿、公开确认及重试命令键。回复使用 v2 AEDS 帧 32971，证明绑定当前登录会话、文章、父评论和完整帧。直接父评论和根评论须仍公开可见。服务端限制每个父评论最多 500 个直接子节点，深度最多 32 层。

独立管理员通过后，服务端重新检查当前公开文章、直接父评论、根评论及收件账号。只有父评论关联有效账号且该账号与回复作者不同，才发送一条私密「收到新的评论回复」站内信。内容采用 v1 通知格式，包含前 40 个 Unicode 码点和评论永久链接。审核、管理员审计、回复通知凭据及该账号的收件箱回放事件在同一 PostgreSQL 事务完成。重复投稿、重复审核、本人回复、作者归属无法证明、账号已停用和待审回复不会追加通知。通过独立申诉首次批准回复时使用同样的检查；原数据库角色维护命令不能把待审或已驳回的受控直接回复改为其他状态。

已送达的消息作为私密历史保存。评论永久链接每次均沿用当前公开查询的可见性规则。旧版匿名回复、v1 提交帧、运营广播和对外邮件仍待接入。 [v1 回复收件人规则](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/CommentService.cs#L671) · [v1 通知投递](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/Background/CommentMutationOutboxWorker.cs#L387)

原生 PostgreSQL 回归验证默认关闭、错误会话与父评论拒绝、待审隔离、审核与通知一并回滚、原命令重试和本人回复免通知。Chrome 经 Caddy TLS 验证 390px 回复操作、独立管理员 Passkey 审核、桌面站内信实时出现以及另一已登录账号无法读取同一会话。停机迁移验证旧结构、重复执行及损坏外键拒绝。[本地验证记录](../../artifacts/comment-reply/)

### 登录作者删除

从公开文章的评论区可删除当前账号发布、且提交事务留存了账号归属记录的评论。相同显示名称不会授予删除权限。停机执行 `comment author-delete-schema` 可启用旧部署的存储，升级前及导入的评论不自动建立归属。文章已撤回时，作者仍可通过原评论 ID 使用已认证的作者接口。

确认删除后才申请有效期五分钟的一次性证明。服务端核对账号、当前会话和评论版本，并在同一事务内消费证明、标记评论删除、追加删除记录和 outbox 事件。公开评论树保留通往已批准回复所需的占位，正文和原显示名称从公共投影中移除。删除事件保留账号、版本、审核状态和正文摘要。独立通知投递、评论编辑及强匿名评论仍属其他流程。 [v1 作者端点](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs#L587) · [#2178](https://github.com/Ozwasyd/FsusBlog/issues/2178)

### 登录作者申诉

旧部署停机执行 `comment appeal-schema` 后，登录账号可以在「我的评论」中查看已证明归属的评论。当前可申诉范围为通过独立管理员线上审核、留有当期驳回记录的评论。申诉理由经去除首尾空白后须为 10–1,000 个 UTF-16 单元。提交消费绑定当前账号、会话、版本和原驳回记录的一次性申诉挑战。每次驳回只接受一条申诉。

持有 `comment.moderate` 的另一名独立管理员可使用当前 Passkey 复核，原审核人不能裁决。确认时重新检查原驳回版本和待复核状态，授权、裁决、审计和事件同事务提交。通过后公开评论读取按现有文章、地区及线程可见性恢复正文。驳回后保留原审核状态。理由和审核身份留在授权范围内。当前没有采用线上独立凭据的隐藏操作，旧数据库角色审核及强匿名评论无法使用本流程。申诉结果的专门通知、对外通用审核时间线和管理员广播待接入。 [固定 v1 治理实现](https://github.com/Ozwasyd/FsusBlog/blob/2605b438eed8f16d12ddddf033d08a6fa18fcd12/src/backend/Services/CommentGovernanceService.cs#L75)

PostgreSQL 验证两名管理员授权、挑战与评论版本绑定、并发裁决、拒绝复核和审计失败回滚。Chrome 经 Caddy TLS 验证作者提交、原审核人看不到待复核项、独立管理员使用 Passkey 通过，以及作者与访客各自读取结果。停机迁移可重跑，并拒绝不完整的表集合。[本地验证记录](../../artifacts/comment-appeal/)
