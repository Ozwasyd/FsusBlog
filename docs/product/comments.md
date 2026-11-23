# 公开评论与评论治理

> **角色**：功能契约
> **适用对象**：站点管理员、前后端维护者
> **权威依据**：默认开关以 [`SiteCapabilities.cs`](../../src/Server/Operations/SiteCapabilities.cs) 为准；端点与事务边界以 `src/Server/Comments/`、`src/Server/Identity/AdminModeration*.cs` 及 `src/Cli/Schema/03-community.sql` 为准。

## 1. 公开评论读取

- 文章页支持评论主列表、直接回复展开、分支分页与评论永久链接（进入永久链接展示目标、必要祖先与相邻节点，并将键盘焦点移至目标）。评论正文严格按纯文本渲染。
- 保留的 AEDS v2 读路径：
  - `GET /api/binary/comment/{articleId}`（根节点按 ID 降序）
  - `GET /api/binary/comment/{articleId}/children/{parentId}`（直接子节点按 ID 升序）
  - `GET /api/binary/comment/{articleId}/context/{commentId}`（永久链接上下文）
  - `GET /api/binary/comment/{articleId}/thread/{rootId}`（线程读取）
- **可见性与隐私边界**：仅返回当前已发布文章的已审核评论；通往已批准后代的必要祖先允许以脱敏占位节点呈现，绝不从未批准分支泄漏作者名或正文；未知地区按保守策略隐藏存在地区屏蔽的评论；缺失、隐藏、删除、地区屏蔽或越权目标统一返回相同不可用响应；所有响应禁用缓存并在返回前复核当前公开快照。

## 2. 受控登录投稿与直接回复

- **默认启用与覆盖**：顶层评论投稿（`FSUSBLOG_PUBLIC_COMMENT_SUBMISSIONS`）与登录直接回复（`FSUSBLOG_SIGNED_IN_COMMENT_REPLIES`）均默认开启，可显式设为 `false` 静默关闭（关闭顶层投稿会连带关闭登录回复）。所有表结构随 `FsusBlog.V2.Cli` 统一的 `plan` / `apply` 初始化。
- **准入前提**：单篇文章需允许评论投稿（可通过后台或 CLI `comment policy ARTICLE_ID enable` 控制）；已启用读者账号需设置公开评论昵称（可在 `/user/identity/mfa` 在线设置，或由 CLI `comment handle ACCOUNT_ID DISPLAY_NAME` 配置）。
- **正文与幂等约束**：正文限制 1,000 UTF-16 码元与 4,096 UTF-8 字节，审核通过前不进入公开查询；重复请求由账号、命令键与请求指纹识别并在单事务中保证幂等。回复限制每个父评论最多 500 个直接子节点、最大深度 32 层（帧 `32971`）。
- **Classic PoW 保护**：客户端以原始投稿/回复 AEDS 帧向 `POST /api/v2/comments/pow-challenge.aeds`（或回复挑战入口）请求 204 字节 `PowChallenge (30)`，在可取消浏览器 Worker 中求解 12-bit FPOW v1 证明并通过 `X-Fsus-Pow-Proof` 提交。默认挑战有效期 120 秒（管理员可通过根评论策略在 60–120 秒间 CAS 调整），绑定会话、可信代理来源、随机 nonce 与请求帧，在写入同一 PostgreSQL 事务中消费一次（回滚同步回滚消费）；每 60 秒每会话限签发 8 次、每来源 24 次。
- **审核后站内回复通知**：统一管理员批准回复时，服务端复核公开文章、父/根评论与收件账号；若父评论归属有效且非本人回复，在同一事务内写入私密「收到新的评论回复」站内信（含前 40 码点摘要与永久链接）及收件箱回放事件。

## 3. 登录作者编辑、删除与申诉

- **作者删除**：仅评论提交事务留存真实账号归属记录的作者本人可删（同名显示名不授删权）；文章撤回后仍可通过原评论 ID 访问作者删除接口。确认后申请 5 分钟一次性证明，在同事务中消费证明、标记软删、追加删除记录与 `CommentDeleted` outbox；公开树仅保留通往已批准后代的脱敏占位。
- **作者编辑**：归属作者可在评论创建后 **30 分钟内**编辑已批准评论（文章页入口）或待审评论（私有「我的评论」入口），要求文章当前公开且无地区屏蔽。编辑读取 AEDS `33003`，保存复用挑战 `215→216` 与命令 `217→218`（5 分钟一次性证明绑定 `edit` 用途、账号、会话、代次、出版物与评论版本）。编辑提交后统一进入人工审核队列（待审期间公开接口不暴露旧正文或新正文），重新批准后保留原坐标并标记 `Edited`。
- **作者申诉与双人独立复核**：登录作者可在「我的评论」对线上管理员驳回的评论提交申诉（理由去空白后 10–1,000 UTF-16 码元，每次驳回限申诉 1 次，消费绑定会话/版本/原驳回记录的一次性挑战）。申诉必须由**另一名独立管理员**使用 Passkey 复核裁决，**原审核人严禁裁决自己驳回的评论**；批准后按现行可见性规则恢复公开正文。

## 4. 评论举报

- 登录读者可对当前公开文章上的已批准评论提交举报（`POST /api/v2/comments/{articleId}/{id}/report.aeds`，AEDS `223→224`，原因沿用 7 项标准分类，附加说明可选、最多 1,000 UTF-16 码元）。
- PostgreSQL 按 `(评论坐标, 举报账号)` 唯一去重：同一账号重复举报同一公开评论返回原随机安全整数报告编号与重复标记；不可见、已撤回或受限目标统一按不可举报拒绝。举报独立记录，不自动篡改评论审核状态。

## 5. 管理员审核队列、批量审核与历史审计

- **统一管理员授权**：评论审核与历史查询沿用统一管理员会话（已移除旧 `comment.moderate` 子权限拆分），所有管理入口均绑定管理员来源、有效会话与 `X-Fsus-Admin-Permission-Session` 响应头，高危决定受 45 秒一次性 Passkey Step-Up 保护（详见 [独立管理员身份](admin-identity.md)）。
- **批量审核**：配置管理员源后 `FSUSBLOG_ADMIN_COMMENT_BATCH` 默认开启（可设 `false` 关闭），支持一次领取并审核 2–20 条待审评论；任一条状态/版本/领取失配或存在地区屏蔽时整批原子返回 `409`。
- **评论修订历史与审核时间线**：
  - `GET /api/binary/author/comments/{commentId}/revisions`（AEDS `222`）：按最新到最旧分页（每页最多 64 条，通过 `Link` 续页）读取原文、编辑与删除快照及 SHA-256；字节、摘要或终态删除凭据不一致时 fail-closed 返回 `503`。
  - `GET /api/binary/author/comments/{commentId}/moderation-timeline`（AEDS `225`，支持 `articleId` 精确限定）：最多返回 128 条完整事件（提交、审核、编辑、删除、申诉、独立裁决及操作者标识）。
- **离线维护审核**：具备数据库写权限的运维可通过 `FsusBlog.V2.Cli comment moderate ARTICLE_ID COMMENT_ID EXPECTED_STATUS approve|reject|hide REASON` 执行单语句前态校验更新，并记录数据库 `session_user` 审计（离线命令不可替代含通知投递的受控直接回复审核）。

## 6. 验证入口

```bash
# 隔离 PostgreSQL 与双会话 HTTPS 评论治理回归
bash tests/EndToEnd/run-admin-tls.sh
FSUSBLOG_TEST_FLOW=comment-author-delete bash tests/EndToEnd/run-native.sh
```
