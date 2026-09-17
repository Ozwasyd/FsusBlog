# Ordinary-Account Session Revocation Consistency

This document defines the runtime consistency boundary between ordinary-account `sys_user_session` and issued access tokens. Once a database session is revoked, its old JWT must fail on the next protected request without waiting for JWT `exp`; public anonymous reads must not become a database hot path.

## Security invariants

1. Passing JWT signature, issuer, audience, `nbf`, and `exp` proves only that the token was issued by this site and remains cryptographically valid; it does not prove that `sid` is still active.
2. An ordinary-account principal must have all of: `identity_kind=anonymous_account`, a valid account ID, valid `sid`, a non-revoked and non-expired session (idle/absolute), a non-deleted account, and a session owner matching the token account ID.
3. The admin principal uses an independent `admin_session` and `IAdminSessionValidationService`; ordinary-session validation must not read or clear the admin session/Cookie.
4. A public anonymous request has no authenticated ordinary principal and performs no ordinary session-cache or PostgreSQL query.
5. The relation is `Account 1 ── N UserSession`; normal login must not revoke other legitimate devices with `login_replaced`, and account-level admission locking plus a configurable limit constrain the active count.

## Request path

`JwtBearerEvents.OnTokenValidated` dispatches after JWT cryptographic validation:

- `identity_kind=admin_principal`: retain the existing admin access-token hash and admin-session checks.
- Ordinary account: call `IUserSessionValidationService.ValidateAsync`; on failure, clear only ordinary access/refresh/session Cookies and reject authentication with `context.Fail(reason)`.

The default ordinary-account validation order is:

1. Read the Redis L2 `SecurityUserSessionValidation` key directly, deliberately bypassing process L1 so another instance's revocation cannot be hidden by this instance's stale in-memory snapshot.
2. On an L2 hit, validate account ID, revoked/expiry state, account-deletion status, and identity kind without touching the database.
3. On an L2 miss, issue one primary-key row query for `sys_user_session.sessionid = @SessionId`, joining `sys_user` for account status. There is no table scan, session-list read, or unbounded per-request fan-out.
4. A Redis read error or corrupt payload enters the bounded PostgreSQL fallback like a miss. An independent concurrency budget and consecutive-failure circuit breaker protect it; budget rejection or database error fails closed.
5. The fallback result carries session/account `xmin::text`, account status, and `session_mode`. Obtain database truth first, then perform best-effort Redis Lua repair with monotonically compared numeric versions. Ordinary write failure does not change the database decision; a version conflict means a concurrent update won, so read the higher winning version and decide again, failing closed if it cannot be read.

Cache payload v3 always carries `rowVersion/accountId/revokedTicks/idleTicks/absoluteTicks/accountStatus/deletedTicks/identityKind/authenticationContext/sessionMode/accountRowVersion` and reads v2 only during the rolling compatibility window. Default L2 TTL is 2 minutes and L1 TTL is 0. TTL controls fallback frequency only; ban/revoke actively publishes a restricted/revoked snapshot instead of waiting for TTL.

## Session modes and restricted allowlist

The server persists `normal < restricted < revoked`. JWT `session_mode` conveys the issuance-time mode but is not authorization truth; if database/cache mode differs from the claim, use the stricter value. In one transaction, ban changes active sessions to restricted, unban changes them to normal, and delete/revoke changes them to revoked. Thus an old normal JWT is restricted on the next request after ban; an old restricted JWT does not silently recover after unban and requires refresh or reissuance.

A restricted principal may use only explicitly marked endpoints: `GET /auth/me` (including the ban reason), `GET /auth/sessions`, refresh, logout, single/other-session revoke, self-account deletion, Passkey step-up begin/complete, and MFA challenge start. Refresh is the explicit path to obtain a new normal JWT after unban. Comment, message, content, identity, public-business, and admin paths without metadata return `423` by default; notification stream returns `restricted_session_not_allowed` before admission/backlog. The allowlist uses neither path prefixes nor a “writes only” inference.

## Revocation write paths

Every write path below must use `UPDATE ... RETURNING` to obtain the updated `xmin`, publish a revoked snapshot as the final step of the same explicit database-transaction callback, and allow commit only after the Redis fence is visible:

| Path | `revokereason` | Retained |
| --- | --- | --- |
| logout / refresh token revoke | `logout` | none |
| Single-session revoke | caller-normalized reason | other sessions |
| Revoke other sessions | `revoke_others` | current `sid` |
| Login expiry cleanup | `session_expired` | unexpired sessions and the newly created session |
| Active-session-limit eviction | `active_session_limit` | the `MaxActiveSessions - 1` least-recently-used old sessions and the newly created session |
| Refresh-token replay | `refresh_token_reuse` | none |
| Recovery Key verify | `recovery_key_verified` | determined by the request's revoke option |
| Account deletion | `account_deleted` | none |

Both producers and cache repair may request overwrite, but version Lua compares numeric row versions and rejects older ones. In the representative race, request A reads active version 7, revoke request B updates the row to version 8 and publishes a revoked snapshot, then A attempts to repair version 7. Lua rejects A; A reads winning version 8 and rejects as revoked, and fails closed if the winner cannot be read. An old active state can never obtain one post-revoke pass. If the database already reads revoked, a repair conflict likewise remains a rejection.

`login`, `revoke-others`, account deletion, and account-level `revoke-all` use the same PostgreSQL transaction-scoped advisory lock. `revoke-others` handles only sessions that existed when the operation began, so a newly created and successfully issued session cannot be accidentally revoked while waiting for the lock. Login admission cleans expired rows and evicts the least recently used by `COALESCE(lastseenat, createdat)` before inserting; the new session is never a candidate, concurrent logins for one account are serialized, and the final active count cannot exceed the configured limit.

Targeted-revoke notifications continue using the account-level `SessionRevoked` payload without session identity. Every receiving tab must recheck `/api/binary/auth/me`: only an invalid local `sid` enters `user-expired` cleanup and cross-tab broadcast; a device whose recheck remains valid keeps its session and private pages, and an unknown network result must not misclassify authenticated state as guest.

Redis publication failure fails the transaction callback and rolls back the database update; the caller must not report success. Parallel batch publication can partially succeed, so once publication has started and the transaction ultimately fails, call `InvalidateManyAsync` for the whole batch of session identities. Apply the same compensation if database commit fails after Redis publication. If deletion compensation fails, retain the revoked snapshot: a database-rolled-back active session may be rejected temporarily, but a revoked session never gains authorization; the next key cleanup, TTL expiry, or DB-only switch restores database truth. An in-process fence must not replace this cross-instance ordering.

## Performance boundaries

- Steady state: one Redis GET per ordinary-account protected request; no PostgreSQL query.
- Redis miss/eviction/TTL expiry: one PostgreSQL primary-key row query, then a short-TTL snapshot refill.
- Redis error/corrupt payload: the same single-row query within the fallback concurrency budget, recording the incident's added DB QPS; reject immediately when the budget is exceeded or the circuit is open.
- Anonymous hot reads such as public articles, public AOT, and public comments do not enter this service without an authenticated principal; added database queries are 0.
- Batch revocation: one `UPDATE ... RETURNING` in the database and parallel cache publication, with no per-session serialized database updates.
- The revocation transaction waits for one parallel Redis publication before commit as the cross-instance immediate-invalidation barrier; do not move it to post-commit fire-and-forget.

## Failure and no-restart rollback

In the default mode, a Redis read failure or corrupt payload falls back to PostgreSQL; only an authoritative state successfully returned by the database may allow access. Database errors, fallback-budget rejection, or an open circuit fail authentication closed, never falling back to “trust JWT only.” Repair-write failure does not turn an already obtained database decision into authentication failure.

The fallback budget uses `Security:UserSessionValidation:DbFallback:MaxConcurrent`, `FailureThreshold`, and `BreakSeconds`, defaulting to 32, 5, and 5. Set it with PostgreSQL-pool headroom; never allow unbounded waiting or queueing.

To isolate the new Redis fast path, set this through a reload-capable configuration provider:

```text
Security:UserSessionValidation:DistributedCacheEnabled=false
```

Existing instances read the new value on the next call and enter safe DB-only mode: skip session Redis reads/writes and pre-commit Redis publication, while every signed ordinary token still queries PostgreSQL by session primary key. Database commit remains the revocation-visibility boundary, so semantics are unchanged. Compensation cleanup ignores this toggle and can still delete keys published before the switch. Use this only for short diagnosis/rollback because it increases protected-request database load; restoring `true` refills from current database state. Do not replace it with disabled session validation, extended JWT lifetime, or fail-open. If the environment-variable provider cannot reload at runtime, use a normal rolling deployment and do not claim a no-restart switch.

To roll back multi-device admission without a restart, hot-update `Security:UserSessions:MaxActiveSessions` to `1`. Later logins evict other active sessions under the same lock, restoring single-session behavior; this does not restore a removed unique index or change explicit single/other/all revocation or refresh-family semantics. Raising the limit again affects only later admission and never creates or revives historical sessions.

## Risks and controls

- Redis failure is handled by the authoritative PostgreSQL fallback; reject authentication only for budget/circuit rejection or simultaneous PostgreSQL failure. DB-only mode above preserves security semantics while temporarily removing Redis dependence.
- DB-only mode increases PostgreSQL QPS: it performs only exact primary-key queries, must be time-limited, and requires pool/latency monitoring.
- Redis publication failure rolls back the transaction and the operation fails; every partially published revoked snapshot enters batch-deletion compensation, so a successful state can never leave an old active snapshot after database revocation.
- If Redis publishes but database commit fails, batch-delete the possibly early-published keys; if deletion fails, retain the revoked snapshot and fail closed, never downgrade to the old active value.
- If Redis is wholly unavailable, reads fall back to PostgreSQL within budget and revocation-producer publication still fails closed. Before recovery, hot-reload DB-only so PostgreSQL primary-key reads and commit preserve revocation semantics.
- Observability: `fsus.auth.session_validation.*` instruments must continuously emit cache hit/miss/error, DB fallback success/rejected/error, repair outcome, validation latency, fallback concurrency, and Redis-failure added DB QPS. Alerts should reduce load or switch to DB-only, never relax authentication.
- Mixed ordinary/admin Cookies: an ordinary validation failure calls only `ClearUserSessionCookies`; the admin Cookie and admin validator remain unchanged.

## Acceptance scenarios and test code

| Scenario | Expected | Coverage |
| --- | --- | --- |
| Anonymous request | Does not read session cache/DB | `UserSessionRevocationIntegrationTests.UnauthenticatedPrincipal_DoesNotReadSessionCacheOrDatabase` |
| Two-device login | Both successful responses' `sid` values map to active rows | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_TwoDeviceLoginsRemainActive` and `CompleteLoginAsync_ConcurrentDevicesUnderLimitReturnActiveSessions` |
| Same-device double-click login | Device fingerprint is not an authorization key; both successful responses get independent active `sid` values | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_ConcurrentSameDeviceCreatesIndependentSessions` |
| Limit eviction | Evicts only the least-recently-used old sessions; the new session remains active | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_ActiveSessionLimitEvictsLeastRecentlyUsedSession` |
| Concurrent limit | Three concurrent admissions with limit 2 end with only two active rows | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_ConcurrentAdmissionsNeverExceedActiveSessionLimit` |
| Login vs. revoke-others | A session created after the operation begins is not accidentally revoked | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_ConcurrentRevokeOthersDoesNotRevokeNewSession` |
| Login vs. account deletion | No active session remains after deletion completes | `UserSessionLoginConcurrencyTests.CompleteLoginAsync_ConcurrentAccountDeletionLeavesNoActiveSession` |
| Ordinary-account login | Active snapshot allows; cache hit does not read DB | `UserSessionValidationServiceTests.CachedActiveSession_AllowsRequestWithoutDatabaseRead` |
| Redis error/corrupt payload | On DB success, use authoritative allow/reject and attempt repair; DB/budget failure fails closed | `UserSessionValidationServiceTests.CacheError_FallsBackToPostgresAndRepairsCache`, `CacheError_PostgresFailureFailsClosed`, and `DbFallbackGate_RejectsExcessConcurrencyAndOpensCircuit` |
| Repair vs. revocation race | Repair conflict cannot override the DB revoked decision | `UserSessionValidationServiceTests.CacheRepairConflict_CannotOverrideAuthoritativeDatabaseRevocation` |
| Ban/unban JWT mode difference | Always use the stricter mode from DB and JWT | `UserSessionValidationServiceTests.SessionModeMismatch_UsesTheStricterServerEffectiveMode` |
| Single-session revoke | A warmed old principal is rejected on its next request | `UserSessionRevocationIntegrationTests.RevokeSession_RejectsPreviouslyIssuedPrincipalAfterCacheWasWarm` |
| Revoke other sessions | Other sessions are rejected; current session remains active | `UserSessionRevocationIntegrationTests.RevokeOtherSessions_InvalidatesOthersAndKeepsCurrentSessionValid` |
| Refresh replay | Old access principal is rejected immediately | `UserSessionRevocationIntegrationTests.RefreshReplay_RevokesSessionAndImmediatelyRejectsOldPrincipal` |
| Concurrent cache miss + revoke | An old active snapshot cannot overwrite the revoked snapshot | `UserSessionRevocationIntegrationTests.ConcurrentCacheMissAndRevoke_DoesNotResurrectStaleActiveSnapshot` |
| Admin request | Continues through the independent admin validator/Cookie cleanup | `UserSessionJwtAuthenticationTests.AdminEndpoint_KeepsIndependentAdminSessionValidationPath` and existing `AdminSessionValidationServiceTests` |
| Notification stream | Revoked principal fails authentication; restricted principal returns `423` before admission/backlog; anonymous public stream retains existing handshake controls | `UserSessionMappedBoundaryTests.MappedNotificationStreamPreflight_RevokedOrdinaryJwtRejectsBeforeAdmissionAndClearsUserCookies`, `NotificationStreamBoundaryTests.RestrictedAuthenticatedSession_IsRejectedBeforeAdmission` |
| Protected binary endpoint | Authorization returns `401` after JWT authentication fails without entering the handler; session-revoke endpoint accepts only ordinary-account principals | `UserSessionMappedBoundaryTests.MappedProtectedBinarySessions_RevokedOrdinaryJwtRejectsBeforeHandlerAndClearsUserCookies` calls mapped `/api/binary/auth/sessions` and asserts AEDS Unauthorized, zero business-facade calls, and only ordinary Cookie cleanup |
| No-restart rollback | Dynamic Redis disable skips Redis reads/writes while retaining DB validation | `UserSessionValidationServiceTests.DistributedCacheToggle_CanEnterDbOnlyModeWithoutRestartOrRedisWrites` |
| Publication failure | Redis publication failure rolls back the database and cleans possibly partial publication | `UserServiceValidationTests.RevokeSessionAsync_PublicationFailureRollsBackAndInvalidatesPossiblePartialSnapshot` and `RecoveryKeyServiceBehaviorTests.VerifyAsync_RevocationPublicationFailureRollsBackDatabaseAndCleansPossiblePartialFence` |
| Commit failure | Published pre-commit fence is batch-cleaned; cleanup failure still rejects in the safe direction | `UserServiceValidationTests.CompleteLoginAsync_CommitFailureInvalidatesPreCommitRevocationFence` |
| Success ordering | logout, revoke-others, login admission eviction, account deletion, and Recovery Key publish before commit | `UserServiceValidationTests.RevocationProducers_PublishDistributedFenceBeforeTransactionCommit`, `CompleteLoginAsync_UsesPostgresLockBoundedAdmissionAndInsertInOneTransaction`, `DeleteAccountAsync_ExecutesAnonymousTombstoneAndAssetRevocationInsideTransaction`, and `RecoveryKeyServiceBehaviorTests.VerifyAsync_WithOnlyRecoveryKey_CreatesPendingSessionWithoutPrematurePasskeyRevocation` |

This change does not alter successful-response PODs or AEDS frame numbers. It adds the internal JWT `session_mode` claim, restricted notification-handshake failure detail, and server-side admission semantics; contract synchronization is in `docs/api/contracts.md`.

When this round adds only test code, the existence of test code must not be described as tests passing; pass status must come from actual execution in the unified verification phase.
