# Admin Integrity Console

Admin Integrity Console 用于排查发布证明链路，不是公开验证 API。

访问入口：

- 前端路由：`/user/manage/integrity-proof`
- 后端只读端点：`GET /api/admin/integrity/console`
- 后端重试端点：`POST /api/admin/integrity/console/proofs/{proofId}/retry`

## 权限

只读和重试都复用现有 `system.config` admin permission。重试还需要 `X-Fsus-Mfa-Proof` 携带 `admin-sensitive` step-up proof。当前实现不新增权限名，避免扩大权限矩阵。

重试端点是 JSON ops endpoint，属于后台运维边界；公开验证仍使用 `/integrity/**` manifest。

## 排障方式

1. 进入 Integrity Proof 页面。
2. 可选输入 `articleId`、`articleRevisionId` 或 `revisionNo` 缩小范围。
3. 查看最近 proof、失败/重试中 proof、透明日志、checkpoint、signing key registry。
4. 对 failed、retrying、pending proof 点击重试；系统会要求 admin step-up。

## 状态含义

- `pending`：proof 尚未完成，通常等待公开读 artifact 或后台任务。
- `ready`：proof 已完成，digest、签名和公开指针可用于验证。
- `failed`：proof 生成失败；console 只显示低敏感 `failureCode`，不显示异常栈。
- `retrying`：管理员或后台已触发重试，等待 proof worker 重新处理。
- `superseded`：该 proof 已被新 revision 或新 proof 替代。
- `not-public`：文章当前不是公开状态，不产出公开 proof。
- `chain-broken`：透明日志链校验失败，需优先检查 log append 和数据迁移。
- `key-revoked`：proof 使用的 signing key 在签名时间点不可接受。

其他辅助状态：

- `signature-invalid`：签名格式、payload 或 key 校验不通过。
- `signature-missing`：ready/superseded proof 缺少签名字段。
- `missing`：对应 log 或 checkpoint 还不存在。
- `stale`：checkpoint 落后于当前 transparency log head。

## 数据边界

Console 不展示 private key、内部异常堆栈、用户隐私数据、评论原文、站内信、审计详情、IP、session 或设备指纹。失败 proof 只展示低基数失败摘要，公开验证 API 不展示失败详情。

## 回退

如需临时降级，网关可拒绝 `/api/admin/integrity/console/proofs/*/retry`，只读 console 不会修改数据。完整回退需 revert console endpoint、前端 route/API 和本文件。
