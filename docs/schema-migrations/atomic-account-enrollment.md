# Atomic account enrollment migration

`20260720-pre-atomic-account-enrollment` 是 additive/compatible migration：新增独立的 `sys_user.registration_state` 和 `account_enrollment_session`，不删除旧列、不重写 Passkey/Recovery/session 表。

现有账号分类：已有 Passkey、未撤销 Recovery Key、或仍有 idle/absolute 有效正式 session 的账号为 `active`；已删除为 `closed`；封禁及无凭据、无有效 session 的候选孤儿为 `suspended`。迁移不会静默删除现有账号。新 bootstrap 才创建 `provisional`。

上线顺序为 expand migration → 同时支持 active 旧账号和 provisional 新账号的应用 → 开启新 bootstrap。回滚时关闭 bootstrap 或回滚应用流量，保留列与 enrollment 表并让 15–30 分钟 TTL worker 清理 provisional 行；不得 drop schema，也不得把 provisional 批量标为 active。若必须恢复旧应用读取，先把仍需保留的历史 `suspended` 账号人工审计为 `active`，新列默认值继续保持 `active`，因此 N-1 写入不会制造 provisional。

验收 SQL 必须验证：active 账号不缺 Passkey/Recovery/有效 session 的迁移证据；provisional 不存在正式 session；active enrollment completion 同时存在首枚 credential 与 formal session；过期清理不命中 active；`registration_state` 和 enrollment state 只包含定义枚举值。
