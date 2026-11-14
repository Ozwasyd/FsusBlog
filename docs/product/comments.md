# 公开评论读取

文章页支持评论主列表、直接回复、分支分页和评论永久链接。回复分支只展示直接子节点，永久链接展示目标、祖先和相邻节点，并把键盘焦点移到目标。评论正文使用纯文本渲染。

当前服务保留 AEDS v2 评论读路径 `GET /api/binary/comment/{articleId}`、`/{articleId}/children/{parentId}`、`/{articleId}/context/{commentId}`、`/{articleId}/thread/{rootId}`。根节点按 ID 降序，子节点和旧 thread 端点按 ID 升序。评论 ID 经过 64 位二进制字段传输，浏览器以十进制字符串保存。

PostgreSQL 查询要求文章当前发布且评论已审核。必要祖先可以作为脱敏占位节点显示，作者名、正文和非必要回复目标均不从未批准分支公开。未知地区按保守规则隐藏任意地区已有屏蔽的内容。缺失、隐藏、删除、地区屏蔽或越权目标的永久链接返回同一不可用响应。响应禁用缓存，返回前再次核对当前公开快照。

受控评论投稿默认关闭。管理员可设置 `FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS=true`，通过维护工具 `comment policy ARTICLE_ID enable` 开放指定文章，再用 `comment handle ACCOUNT_ID DISPLAY_NAME` 为现有已启用账户配置明确公开的显示名。文章页只向符合条件的当前会话显示表单，提交者确认显示名和发布坐标后可发送顶层评论。正文限制为 1000 个 UTF-16 单元和 4096 个 UTF-8 字节，在审核前不会进入公开查询。重复请求由账号、命令键和请求指纹共同识别，成功写入和幂等记录在同一事务内提交。

启用投稿后必须完成 classic PoW。客户端以原投稿的 AEDS 帧请求 `POST /api/v2/comments/pow-challenge.aeds`，收到 v1 的 204 字节 PowChallenge (30) 载荷，再在可取消的 Worker 中求解并用 `X-Fsus-Pow-Proof` 发送 FPOW v1 证明。12 bit 难度适用于此专用入口。浏览器每次生成随机 nonce，不采集浏览器指纹。挑战有效期 120 秒，绑定会话、经过可信代理处理的地址、随机 nonce 和投稿帧。每 60 秒每会话最多签发 8 次，同一来源最多 24 次，服务端另有并发上限。使用 Worker 避免阻塞界面，超时或离开文章时停止计算。

验证后的签名只在 PostgreSQL 事务内消费一次。评论写入回滚时消费一同回滚。请求结果丢失时，原命令键可以携新签发的证明取回同一待审结果。服务重启会使此前签发的挑战到期。旧匿名通用挑战入口、其他写动作和风险聚合都不属于此实现。

有维护数据库写权限的操作员可使用 `comment moderate ARTICLE_ID COMMENT_ID EXPECTED_STATUS approve|reject|hide REASON`。命令在一个语句内检查前态、更新状态并记录前后状态、当前数据库角色、理由与时间。数据库角色标识本次操作；共用凭据无法提供个人归因。该工具未实现 v1 的管理台审核队列和 `comment.moderate` 授权。

投稿使用独立的 v2 授权与提交端点。v1 完整评论策略、动态风险策略和复合证明、回复提交、匿名证明、自有评论管理和生产评论迁移仍有缺口。原生 PostgreSQL 集成在独立临时数据库中验证四个读端点、跨文章/撤回可见性，以及并发投稿重试、授权拒绝和 pending 隔离。
