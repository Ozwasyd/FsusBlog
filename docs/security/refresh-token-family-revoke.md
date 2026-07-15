# Refresh-token replay family revocation

## Security invariant

Refresh rotation remains a compare-and-swap on `sessionId + current refresh hash + active expiry`. If the presented hash no longer identifies the active row, the replay path must not perform a separate read followed by a later revoke. It executes one PostgreSQL transaction whose data-changing statement:

1. selects the requested active session only when its current hash differs from the stale presented hash;
2. locks that row with `FOR UPDATE`;
3. revokes every active session for the same account whose `deviceFingerprint` is `IS NOT DISTINCT FROM` the target family value;
4. returns the revoked row versions and publishes revoked session-validation snapshots before transaction commit.

The equality direction matters: `currentHash == staleHash` is not evidence that another holder won rotation, while `currentHash != staleHash` closes the replay window. No raw refresh token, session id, device fingerprint or account id is emitted in metrics.

## Failure and rollback

Redis snapshot publication failure rolls back PostgreSQL. If Redis was published but the database commit fails, the service best-effort invalidates those snapshots; retaining a revoked snapshot is the safe temporary failure mode. A transaction failure returns refresh failure and never issues a replacement token.

There is no runtime switch that restores the read-then-update path. No-restart degradation uses the existing `Security:UserSessionValidation:DistributedCacheEnabled=false` DB-only mode: PostgreSQL remains the revocation truth and replay family revoke stays enabled. Image rollback is safe only to a release that preserves the same atomic transaction invariant; otherwise keep the current release and clear ordinary sessions.

## Observation and response

- `fsus.auth.refresh.replay_detected_count` counts replay suspicions.
- `fsus.auth.refresh.family_revoke_count` counts sessions revoked from matched families.
- `fsus.auth.refresh.family_revoke_window_count` counts replay windows atomically closed.
- `auth_refresh_family_revoke` fires when the five-minute window count is above zero and blocks release closeout pending investigation.

Repeated stale requests after a family is revoked are idempotent: they do not change `revokedAt`, do not recreate an active holder, and do not publish another revoked snapshot.

## Scenario coverage

Focused tests cover the initial stale-token path, two concurrent refreshes with one CAS winner, repeated replay thrash, same-device family revocation, different-device preservation, and immediate rejection of already-issued ordinary principals. Anonymous requests and public Binary reads have no session row and do not enter this code. Independent admin-principal sessions are stored separately and are not revoked. Notification stream behavior is unchanged; ordinary streams observe session invalidation on their next authenticated boundary and retain the existing reconnect/replay protocol.
