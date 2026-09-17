# User session lifecycle and refresh boundary

`UserSessionCommandService` owns active-session queries, revocation, refresh
rotation, and replay-family revocation. It depends directly on the database,
JWT issuer, and session-validation cache and no longer forwards any operation
through `UserService`.

Revocation cache fences are published before transaction commit. A publication
failure rolls back the database change and triggers best-effort cleanup of any
partial cache snapshots. Refresh rotation retains its compare-and-swap update;
a stale token revokes the active device family under row locks.

The existing `IUserSessionCommandService` endpoint contract is unchanged. The
core gateway now uses this narrow service for refresh and logout. Runtime cache
degradation remains fail closed and does not authorize a database-revoked
session.
