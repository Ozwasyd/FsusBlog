# Comment draft privacy

## 安全目标

评论草稿按发布身份分成两个边界：

- `zk_anonymous`：正文仅保存在当前 Vue 组件内存；刷新、关闭标签页或重启浏览器后不可恢复。
- `public`：用户明确打开“公开显示我的名称”后，正文可以 best-effort 写入 `localStorage`，用于刷新和浏览器重启后的恢复。

当前阶段不提供 PRF 加密 vault，也不把匿名正文写入 `sessionStorage`、IndexedDB 或 Cache Storage。未来若引入加密持久化，必须单独完成 key lifecycle、cross-account unlinkability、recovery、migration 与浏览器备份威胁模型，不能复用 credential vault 的结论。

## 存储契约

公开草稿使用 `fsus:comment-public-draft:v2:<local-scope>:<article>:<reply>`。`local-scope` 是浏览器端密码学随机值，不由 account id 哈希或编码得到；账号退出、切换、过期、删除和 panic wipe 时 scope 与草稿一起删除，因此不同账号生命周期无法通过 key 比较。payload 只包含：

- schema `version = 2`；
- public 正文；
- `savedAt`；
- `policyHash`。

payload 不保存 `authorMode`、`publicSendConfirmed`、account id 或匿名 credential/proof。旧 `fsus:comment-draft:v1:*` 可能同时含原始账号 ID 和匿名明文，初始化时不迁移正文，直接删除。

## 状态与清理

| 事件 | public 持久草稿 | anonymous 内存草稿 | 发布行为 |
| --- | --- | --- | --- |
| public 编辑、policy hash 相同 | 保存并可自动恢复 public 模式 | 无 | 正常 |
| public 切到 anonymous | 先删除同一公开副本 | 正文留在当前内存 | 删除失败则匿名 fail closed |
| policy hash 改变 | 保留为待审查候选 | 不自动载入 | 用户点“审查草稿”后正文才进入编辑器，身份重置 |
| logout / account switch / session expiry / account deletion | 清除 scope 与全部草稿 | 清除 | 新账号重新生成 scope |
| credential revoked / issuer key rotation / root retired / epoch changed | 不影响无关 public 草稿 | 清除当前匿名正文 | 重新准备 credential 后再编辑 |
| feature disabled | 不影响无关 public 草稿 | 清除当前匿名正文 | 匿名入口关闭，public 仍需明确选择 |
| panic / shared-device / migration failure | 清除 scope、legacy 与全部草稿 | 清除 | 只允许从干净状态重新开始 |

存储 API 完全不可用时，公开草稿退化为内存行为，匿名模式不会获得新的持久 sink。若浏览器允许读取旧副本但拒绝删除，界面显示清理失败并暂停匿名提交，避免磁盘上的公开副本与新匿名正文形成可关联副本。

## 自动化门禁

`tools/security/check-comment-draft-privacy.mjs` 约束：

1. composer 不直接拥有 Web Storage、IndexedDB 或 Cache Storage 写入 sink；
2. 唯一持久 owner 的类型与运行时校验只接受 public draft payload；
3. 存储 owner 不含 account id、author mode、public confirmation 或 `zk_anonymous`；
4. registry 同时登记 v2 public prefix、local scope 与 v1 legacy purge；
5. 扫描 frontend source，拒绝匿名模式与浏览器持久写入重新相邻出现。

定向行为测试覆盖 public/anonymous 切换、同 policy 恢复、policy 变化显式审查、账号切换、credential epoch 清理、legacy 清理失败和 scope 轮换。

## 风险与无需重启的降级

公开草稿仍是浏览器明文，因此只允许保存用户已明确选择公开署名的正文；站点数据备份、浏览器同步和恶意扩展仍可读取它。遇到清理或匿名生命周期异常时，可通过 reloadable 配置热更新 `AnonymousIdentity:ZkAnonymousCommentsEnabled=false` 或 `AnonymousIdentity:ZkProd:Enabled=false`。下一次 policy 刷新触发 `feature-disabled` purge，匿名内存正文被清除，公开评论与公开草稿继续工作；需要更强处置时使用现有 panic wipe 清除所有 FsusBlog 私有浏览器状态。该降级不改变 admin、notification stream 或 binary API 契约，也不需要服务端重启。
