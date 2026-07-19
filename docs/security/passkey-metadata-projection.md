# Passkey metadata 与 PasskeyEnabled 投影

本文定义普通账号 Passkey assertion 元数据和 `sys_user.passkey_enabled` 的安全边界。WebAuthn credential 集合是物理事实源；布尔字段只用于减少常用账号快照的查询成本。

## Assertion 元数据

登录与普通账号 step-up 都在 FIDO 验证成功后解析 authenticator data，并复用 `PasskeyService` 的同一个 CAS 更新：

| 值 | 来源 | 持久化规则 |
| --- | --- | --- |
| `SignCount` | 已验证 assertion | 与原 counter 和 PostgreSQL `xmin` rowVersion 一起比较后推进 |
| `LastUsedAt` | 服务端 UTC 时间 | 只随成功 CAS 更新 |
| `BackupEligible` | authenticator data BE flag | 与 counter/LastUsedAt 同一 SQL statement 更新 |
| `BackupState` | authenticator data BS flag | 与 counter/LastUsedAt 同一 SQL statement 更新，可由 false 变为 true 或反向变化 |
| flags snapshot version | 服务端常量 `1` | 表示当前解析 BE/BS 的代码语义；不作为身份、授权或设备指纹持久化 |

CAS 失败后重新读取 counter 与 rowVersion。数据库已被更新到当前 assertion 的 counter 或更高值时，不允许较旧 assertion 回写 BE/BS；仍需推进时只重试一次完整 metadata CAS。无法收敛时返回 `credential_metadata_conflict`，不能创建登录 Session。BE/BS 变化本身不是 compromise 信号，也不会撤销现有 Session。

`PasskeyMetadata:AssertionUpdateMode` 默认执行完整更新。发生 Fido2NetLib flags 解析或数据库兼容事故时，可通过 reload-capable 配置源热更新为 `counter_only`；下一次请求仍更新 counter 与 LastUsedAt，但暂时冻结 BE/BS，不关闭签名验证、counter 检查或 CAS。修复后删除该覆盖即可恢复完整更新，无需重启。

## PasskeyEnabled 事实源

权威关系固定为：

```text
EXISTS(passkey_credential WHERE account_id = sys_user.id)
    == sys_user.passkey_enabled
```

注册把 credential insert 与 `PasskeyEnabled=true` 放在同一事务。Recovery Key 补绑已经在同一事务插入 credential、按策略撤销旧 credential 并设为 true。删除凭据在行锁事务中完成，并按剩余事实集合把投影设为 true 或 false。账号注销在同一事务删除全部 credential 并把投影归零。业务授权、WebAuthn allow-list 和恢复判断继续读取 credential 事实集合，不得只信任布尔投影。

startup 在 schema compatibility 与 account subject invariant 后运行 `passkeyProjectionInvariant`。发现漂移只记录数量与固定原因 `credential_fact_mismatch`，不记录 account ID、credential ID、public key、user handle 或 authenticator data，并阻止后续 bootstrap task。

## 离线检查与修复

使用与 backend 相同的 secret/env-file 输入运行只读检查：

```bash
dotnet run --project src/backend/FsusBlog.Server.csproj -- \
  passkey-projection --check --env-file /run/secrets/fsusblog.env
```

检查输出只包含 `status`、mode 和数量。发现 drift 后，在停止并发 schema/manual mutation 或处于受控维护窗口时执行：

```bash
dotnet run --project src/backend/FsusBlog.Server.csproj -- \
  passkey-projection --repair --confirm-repair \
  --env-file /run/secrets/fsusblog.env
```

repair 只从 credential `EXISTS` 重建布尔值。受影响账号的 `AccountSnapshotVersion` 在数据库事务提交前逐一递增；Redis 失效失败会回滚数据库 mutation，已成功的额外 version bump 是安全的。输出和日志仍只有数量，不包含被修复账号列表。

## 凭据列表与恢复提示

现有 Passkey credential list 只返回内部管理 row ID、友好名称、创建/最近使用时间、AAGUID 类别和 BE/BS；不返回 WebAuthn credential ID、public key、user handle 或原始 authenticator flags。内部 row ID 仅用于已认证的重命名/删除路由，不是 WebAuthn 标识。

客户端可用 credential 数、`BackupEligible` 和账号 recovery 状态提示恢复能力：只有一枚不可备份 credential 且无 Recovery Key 时建议增加第二枚 Passkey或创建 Recovery Key；已有多枚 credential、可备份 credential 或 Recovery Key 时不重复提示。当前 Session 的创建 credential 必须等 Session provenance 契约提供可信关联后再标记，不能用 AAGUID、User-Agent、IP 或猜测的设备指纹代替。

## 风险与回退

- metadata CAS 失败会拒绝当前 assertion，不会产生“Session 已创建但 metadata 未提交”的半认证状态。
- `counter_only` 是无需重启的 flags 更新降级；不得回退到 blind update。
- projection repair 失败保持旧投影并返回非零退出码；再次检查仍能看到 drift。
- startup gate 的紧急回退是把流量保留在上一服务槽，先运行离线 repair，再重新启用候选槽；不得通过让业务只信任 `PasskeyEnabled` 绕过 gate。
