# Passkey 测试治理与保留映射

本文记录 GitHub issue #1044 对 Passkey 测试的精简边界，以及 #1181 增补的 WebAuthn counter 状态机行为。目标是删除 C# record/constructor 编译器语义断言和私有 SQL 源码形状断言，同时保留缓存安全、匿名账号 metadata、随机 handle ownership、实体映射、counter 分类和 PostgreSQL 并发行为。

## Before / after

统计口径为 `tests/backend/Unit/PasskeyServiceTests.cs`，并单列其 PostgreSQL replacement owner `PasskeySignCountConcurrencyTests.cs`。Theory 的每个数据行按一个展开 case 计数。

| 指标 | Before | After | 变化 |
| ------ | -------- | ------- | ------ |
| `PasskeyServiceTests` 测试方法 | 33 | 9 | -24（-72.7%） |
| `PasskeyServiceTests` 展开 case | 39 | 20 | -19（-48.7%） |
| `PasskeyServiceTests` 行数 | 560 | 168 | -392（-70.0%） |
| 加上 `PasskeySignCountConcurrencyTests` 的测试方法 | 37 | 14 | -23（-62.2%） |
| 两文件总行数 | 809 | 592 | -217（-26.8%） |

## Retention replacement

机器可读的逐 test ID 声明位于 [`tests/test-retention-replacements.json`](../tests/test-retention-replacements.json)。语义映射如下：

| 删除或合并的旧证据 | 当前 owner | 保留理由 |
| -------------------- | ------------ | ---------- |
| `CachePolicyId_PasskeyValues_AreDistinct` | 两个 stable numeric value 测试 | `24` 与 `25` 的精确持久化契约已经蕴含 distinct |
| registry presence、`SecurityCritical`、L1/L2 TTL、jitter、tags、domain/resource 的 8 个碎片方法 | `CachePolicyRegistry_PasskeyPolicies_PreserveSecurityContract` | 两个 policy ID 作为同一表驱动 theory 的数据行，全部原断言仍在 |
| registration/authentication key 的两个独立方法 | `CachePolicy_PasskeyChallenge_BuildKeyUsesPolicyDomainAndResource` | 一个 theory 同时锁定两个完整 key |
| empty/whitespace identity 两个方法 | `CachePolicy_PasskeyChallenge_EmptyIdentityNormalizesToDefault` | 两个输入成为一个 normalization theory 的数据行 |
| 4 个 metadata 碎片方法 | `BuildAnonymousSafeMetadata_MapsAccountLabelsAndPreservesStoredRandomHandle` | 直接调用实际 metadata 映射，覆盖匿名 fallback、public handle trim、legacy 隔离与 defensive copy |
| stored random handle ownership 与 internal account ID source search | `CredentialOwnership_AcceptsStoredRandomHandleAndRejectsInternalAccountIdDerivation` | 直接验证 stored handle 成功、`BitConverter.GetBytes(accountId)` 失败、缺失 handle 失败 |
| Passkey begin 的 POD/model/service 私有块源码读取 | `PodBinaryCodecTests.PasskeyRegisterBegin_RoundTrip_PreservesOptions` + metadata behavior + stable-handle race | wire、label 和并发持久化由各自的可观察行为 owner 覆盖 |
| `PasskeyCredential.AccountId` 与 legacy `UserId` source search | `PasskeyCredential_UsesAccountIdColumnAndIndexWithoutLegacyUserId` | 反射锁定真实 entity column/index，避免依赖 service 局部变量名 |
| optimistic sign-count SQL/private helper shape | `PasskeySignCountConcurrencyTests.UserPasskeySignCount_ConcurrentStaleRowVersionAllowsOnlyOneUpdate` | 两个 PostgreSQL stale writer 只能一个成功，最终计数为新值 |
| signCount 布尔源码形状与 clone 文案 | classifier matrix + `PasskeyCounterRollbackIntegrationTests` | `0 -> 0`、单调推进、non-monotonic risk、默认 session 隔离和显式账户响应均由可观察行为覆盖 |
| CAS conflict 统一当成 rollback | `PasskeySignCountConcurrencyTests.UserPasskeyAssertion_ConcurrentCasConflictReloadsWithoutCloneResponse` | 两个已验证 assertion 竞争 stale rowVersion 后都安全收敛，最终 counter 单调且不撤销 Session |
| stable handle `FOR UPDATE`/SQL shape | `PasskeySignCountConcurrencyTests.StablePasskeyUserHandle_ConcurrentFirstRegistrationReturnsOneFinalHandle` | 两个真实 service/DB 并发初始化得到同一最终持久化 handle |
| last-credential delete SQL/private helper shape | `PasskeySignCountConcurrencyTests.RemoveCredentialAsync_ConcurrentDeletesKeepOnePasskeyWithoutRecovery` | 两个公开 service delete 并发调用只允许一个成功，最后 credential 与 flag 保持安全 |
| 6 个 `PasskeyCredentialSummaryDto_*` constructor/record 测试 | `PodBinaryCodecTests.PasskeyCredentialList_RoundTrip_PreservesCredentials` | 实际 AEDS list round trip 保留 nullable 字段、ID、时间和两个 backup flag；record equality 不再作为业务契约 |

## Mutation evidence ownership

下表声明 mutation target、应由哪个行为测试杀死，以及失败信号。当前 issue 阶段按任务约束只落地代码，不运行 mutation 或其他验证；运行结果必须由后续统一验证绑定当前 source state 后写入 release evidence，本文不预填成功状态。

| Mutation target | Evidence owner | 预期失败信号 |
| ----------------- | ---------------- | -------------- |
| 改动 Passkey cache policy numeric ID | 两个 stable numeric value 测试 | 精确整数不相等 |
| 关闭 `SecurityCritical`，改变 TTL/jitter/tags/domain/resource | consolidated policy theory | 对应 policy row 断言失败 |
| 删除 identity trim/default normalization | key normalization theory | empty/whitespace key 不再等于 `...:default` |
| metadata 恢复 internal ID/username label，或直接返回 caller byte array | metadata theory | label、handle 内容或 defensive-copy 断言失败 |
| credential ownership 接受 account-ID-derived bytes | ownership behavior | negative case 变为 true |
| entity 恢复 `UserId`/旧 column/index | entity reflection contract | property、column 或 index 断言失败 |
| stable handle 初始化失去并发串行化 | stable-handle PostgreSQL race | 两个返回值/持久化值不一致 |
| sign-count 更新失去 stale row guard | sign-count PostgreSQL race | 两个 writer 同时成功或最终计数异常 |
| `0 -> 0` 恢复为风险、登录与 step-up 分叉，或默认撤销全账号 Session | counter classifier + integration state machine | 分类、成功结果、audit response action 或 Session mock 断言失败 |
| CAS conflict 不重读或误报 clone | concurrent assertion PostgreSQL race | 两个 assertion 不能同时安全完成、最终 counter 不是最大值或触发 Session revoke |
| 最后一枚 credential 删除失去事务保护 | concurrent public delete race | 两次删除同时成功或剩余数变为 0 |

## 统一验证入口

后续验证阶段必须覆盖 auth/security focused tests、`Category=Concurrency` PostgreSQL tests、backend unit、retention audit、critical mutation slice 和完全 fresh production tier。任何结果只有在绑定当前 commit、worktree fingerprint 与同一 production run id 后才可作为 #1044 的完成证据。
