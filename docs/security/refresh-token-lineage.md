# Refresh Token lineage

## Security invariants

Each `sys_user_session` receives an independent random 256-bit `refresh_family_id` at creation and keeps it for the login session's lifetime. `refresh_generation` increases monotonically from 0; normal rotation neither creates a new session nor a new family. The database stores only the current token's SHA-256 hash and used-token hash tombstones. No table, log, audit, metric, or notification payload may store a plaintext token or a complete hash.

The `SessionId` Cookie is an anti-confusion context, not a family locator. The server first looks up the current generation or tombstone by refresh hash and then acts on server evidence; an incorrect client-supplied session id cannot revoke another session without evidence.

## Atomic rotation and results

The production `POST /api/binary/auth/refresh-token` entry point uses one PostgreSQL data-modifying CTE:

1. CAS the active session using `sessionid + refresh_family_id + refresh_generation + current hash`, then in the same statement write old hash, family, session, generation, use time, and expiry to `user_refresh_token_tombstone`.
2. Increment generation and update `refresh_rotated_at_utc`, `LastSeenAt`, and idle expiry; give new Access/Refresh Tokens only to the CAS winner.

The result classes are fixed:

| State | HTTP / AEDS code | Server action |
| --- | --- | --- |
| Success | 200 `EmptySuccess` | Write the new Cookie. |
| Same CAS loser | 409 `REFRESH_ROTATION_CONFLICT` | Issue no token; do not misreport a CAS conflict as confirmed replay. |
| Tombstone replay | 401 `REFRESH_FAMILY_COMPROMISED` | Mark and revoke the token's family, then clear the Cookie. |
| Token / SessionId mismatch | 401 `REFRESH_SESSION_MISMATCH_COMPROMISED` | Revoke the family supported by token evidence; do not touch another family named by the Cookie. |
| Ordinary expiry or unknown | 401 `REFRESH_EXPIRED_OR_UNKNOWN` | Clear the Cookie without fabricating compromise evidence. |
| Cookie/response delivery failure | 401 `REFRESH_DELIVERY_FAILED` | Revoke the rotated family; do not restore the old generation. |

The client must not replay the refresh POST automatically. On an unknown response, only bounded rereads of idempotent `/auth/me` are allowed; if the new Cookie cannot be confirmed, return to login.

## Retention, cleanup, and migration

Tombstones are retained for at most 30 days. Each refresh first removes expired rows and historical families for revoked sessions. When a family is compromised or a session is revoked for delivery failure, its tombstones are removed in the transaction; session deletion uses `ON DELETE CASCADE`. The tombstone table contains only token hash, family/session/generation, and timestamps; it does not copy account, IP, User-Agent, device fingerprint, or authentication material.

`20260720-pre-user-session-refresh-lineage` is an additive Expand migration: backfill each old session's family with its existing unique `sessionid`, generation with 0, and rotation time from `LastSeenAt/CreatedAt`; new versions write a random family. For N-1 compatibility, the new session columns are not tightened to `NOT NULL` during Expand; application code falls back to the unique `sessionid` for an empty family during migration. The migration creates unique family/hash indexes, and the new tombstone table enforces non-negative generation and expiry from creation. Old versions ignore the new columns and continue reading/writing the original session fields during rolling release.

## Risk and no-restart rollback

If lineage rotation or tombstone lookup fails on a candidate, remove that slot at the gateway and return traffic to the last-known-good slot. The additive schema and old `refreshtokenhash` remain, so no database rollback or old-slot restart is required. During rollback, do not delete new columns/tables, restore old tokens, disable replay revocation, widen revocation by device fingerprint, or make the refresh endpoint automatically retry. Before restoring traffic, verify migration history, the tombstone unique index, and focused PostgreSQL CAS tests.

## Verification scenarios

- Anonymous bootstrap/enrollment, logged-in accounts, and Passkey login create family generation 0; consecutive multi-generation rotation preserves monotonic generation and hash-only tombstones.
- Two concurrent refreshes have one CAS winner. Generation N-1 replays after N is active and still locates the family when `SessionId` is missing; an incorrect `SessionId` does not affect another session/family.
- Validation failure before or after Cookie write revokes the rotated family; single-session/account revoke and account deletion still invalidate the current generation.
- Tests cover tombstone TTL, expiry cleanup, family-revoke cleanup, and foreign-key cascade. Notification receives only the existing low-sensitivity `SessionRevoked`; binary endpoints keep AEDS `ApiError/EmptySuccess` with no JSON fallback.
