# Refresh Token lineage

## 安全不变量

每条 `sys_user_session` 在创建时获得一个独立、随机 256-bit `refresh_family_id`，整个登录会话期间保持不变。`refresh_generation` 从 0 单调递增；正常轮换不是新 session，也不创建新的 family。数据库只保存当前 token 的 SHA-256 hash，以及已使用 token 的 hash tombstone，任何表、日志、audit、metric 或 notification payload 都不得保存 token 明文或 hash 全值。

`SessionId` Cookie 是防混淆上下文，不是 family locator。服务器先用 refresh hash 查当前 generation 或 tombstone，再根据服务端证据决定处置；客户端提供的错误 session id 不能导致无证据的其他 session 被撤销。

## 原子轮换与结果

生产入口 `POST /api/binary/auth/refresh-token` 使用单条 PostgreSQL data-modifying CTE：

1. 以 `sessionid + refresh_family_id + refresh_generation + current hash` CAS 当前 active session；
2. 同一语句把旧 hash、family、session、generation、使用时间和到期时间写入 `user_refresh_token_tombstone`；
3. generation 加一，并更新 `refresh_rotated_at_utc`、`LastSeenAt` 与 idle expiry；
4. 只有 CAS winner 获得新 Access/Refresh Token。

结果分类固定如下：

| 状态 | HTTP / AEDS code | 服务端处置 |
| --- | --- | --- |
| 成功 | 200 `EmptySuccess` | 写入新 Cookie |
| 同一 CAS loser | 409 `REFRESH_ROTATION_CONFLICT` | 不取得 token；不把 CAS conflict 误报为已确认 replay |
| tombstone replay | 401 `REFRESH_FAMILY_COMPROMISED` | 标记并撤销 token 所属 family，清 Cookie |
| token / SessionId 不匹配 | 401 `REFRESH_SESSION_MISMATCH_COMPROMISED` | 按 token 证据撤销其 family，不触碰 Cookie 指向的其他 family |
| 普通过期或未知 | 401 `REFRESH_EXPIRED_OR_UNKNOWN` | 清 Cookie，不伪造 compromise 证据 |
| Cookie/响应交付失败 | 401 `REFRESH_DELIVERY_FAILED` | 撤销已轮换 family，旧 generation 不恢复 |

客户端不得自动重放 refresh POST。响应未知时只允许有界回读幂等 `/auth/me`；无法确认新 Cookie 时回到重新登录。

## 保留、清理与迁移

Tombstone 最大保留 30 天；每次 refresh 在查询前清理已过期行以及已撤销 session 的历史 family。family 被 compromise 或 session 因 delivery failure 撤销时，事务内立即清理该 family 的 tombstone；session 删除时外键 `ON DELETE CASCADE` 清理。tombstone 表只有 token hash、family/session/generation 和时间，不复制账号、IP、User-Agent、设备指纹或认证材料。

`20260720-pre-user-session-refresh-lineage` 是 additive Expand migration：旧 session 的 family 回填为其既有、唯一的 `sessionid`，generation 回填为 0，rotation time 使用 `LastSeenAt/CreatedAt`；新版本写随机 family。为保持 N-1 兼容，既有 session 新列在本次 Expand 阶段不做 `NOT NULL` tightening；应用层对迁移窗口内空 family 回退到唯一 `sessionid`。迁移创建唯一 family/hash 索引；新 tombstone 表从创建起约束非负 generation 与 expiry。旧版本忽略新增列，滚动发布期间仍可读写原 session 字段。

## 风险与无需重启的回退

若候选版本的 lineage 轮换或 tombstone 查询异常，从网关摘除候选 slot 并把流量切回 last-known-good serving slot；additive schema 和旧 `refreshtokenhash` 保留，因此无需数据库回滚或重启旧 slot。回退期间不得删除新增列/表、恢复旧 token、关闭 replay 撤销、按 device fingerprint 扩大撤销，或把 refresh endpoint 改成可自动重试。待修复版本重新接流量前，先核对 migration history、tombstone unique index 和 focused PostgreSQL CAS 测试。

## 验证场景

- 匿名账号 bootstrap/enrollment 与登录账号、Passkey 登录都创建 family generation 0；
- 多代连续轮换保存单调 generation 和 hash-only tombstone；
- 两个并发 refresh 只有一个 CAS winner；
- generation N-1 在 N 生效后 replay，并在缺失 `SessionId` 时仍定位 family；
- 错误 `SessionId` 不误伤其他 session/family；
- Cookie 写入前、写入后验证失败都撤销已轮换 family；
- 单 session/account revoke 与 account delete 继续使当前 generation 失效；
- tombstone TTL、过期清理、family revoke 清理和外键级联均受测试约束；
- notification stream 只接收既有低敏 `SessionRevoked` 事件；binary endpoint 继续使用 AEDS `ApiError/EmptySuccess`，没有 JSON fallback。
