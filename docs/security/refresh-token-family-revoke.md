# Refresh-token replay family revocation

## Security invariant

Refresh rotation remains a compare-and-swap on `sessionId + current refresh hash + active expiry`; the complete token lineage is in [Refresh Token lineage](refresh-token-lineage.md). If the presented hash no longer identifies the active row, replay never does a separate read then revoke. One PostgreSQL data-changing transaction:

1. selects the requested active session only when its current hash differs from the stale presented hash;
2. locks it with `FOR UPDATE`;
3. revokes every same-account active session whose `deviceFingerprint` is `IS NOT DISTINCT FROM` the target family value;
4. returns revoked row versions and publishes revoked session-validation snapshots before commit.

Equality direction matters: `currentHash == staleHash` is not evidence another holder won; `currentHash != staleHash` closes the replay window. Metrics emit no raw refresh token, session id, device fingerprint, or account id.

## Failure and rollback

Redis publication failure rolls back PostgreSQL. If Redis published but commit fails, best-effort invalidation runs; retaining a revoked snapshot is the safe temporary mode. Any transaction failure returns refresh failure and never issues a replacement token.

No runtime switch restores read-then-update. No-restart degradation uses `Security:UserSessionValidation:DistributedCacheEnabled=false` DB-only mode: PostgreSQL remains revocation truth and family revoke stays enabled. Image rollback is safe only to a release preserving this atomic invariant; otherwise keep the current release and clear ordinary sessions.

## Observation and response

- `fsus.auth.refresh.replay_detected_count` counts replay suspicions.
- `fsus.auth.refresh.family_revoke_count` counts sessions revoked from matched families.
- `fsus.auth.refresh.family_revoke_window_count` counts replay windows atomically closed.
- `auth_refresh_family_revoke` fires when the five-minute window count is above zero and blocks release closeout pending investigation.

Repeated stale requests after family revocation are idempotent: they do not change `revokedAt`, recreate an active holder, or publish another revoked snapshot.

## Scenario coverage

Focused tests cover the initial stale-token path, two concurrent refreshes with one CAS winner, replay thrash, same-device family revocation, different-device preservation, and immediate rejection of already-issued ordinary principals. Anonymous/public Binary reads have no session row; independent admin-principal sessions are separate and not revoked. Notification behavior is unchanged: ordinary streams observe invalidation at the next authenticated boundary and retain reconnect/replay.
