# Admin operations health boundary

`IAdminOperationsHealthReader` owns the production operations health read model:

```text
GET /api/binary/author/ops/health
  -> IAdminOperationsHealthReader
       -> production readiness and runtime state snapshots
       -> backup and search diagnostics readers
       -> queue backlog and recent error projections
       -> environment plus IReleaseIdentityProvider snapshot
```

The endpoint depends on the narrow reader directly. `AdminIntegrityOperations`
does not own or forward health composition. The health reader composes the
narrow backup and cache diagnostic ports but never calls back into integrity
operations.

`OpsHealthResponse.releaseIdentity` is an admin-only nested contract with the
explicit fields `releaseId`, `commitSha`, and `releaseSlot`. The reader never
consults `GITHUB_SHA`, `FSUSBLOG_COMMIT`, assembly version, or informational
version. Assembly informational metadata is only a production startup mirror:
when it is missing, local-only, or differs from the canonical runtime ReleaseId,
startup fails closed with a non-secret diagnostic code.

The legacy-named schema migration history column `app_version` is now an audit
mirror of the same provider `ReleaseId`. It is not a schema compatibility
coordinate and does not replace the independent compatibility fence introduced
by issue #1317.

The public readiness body remains limited to `status` and `checkedAt`. Public
responses continue to expose only `X-Fsus-Release-Id` and
`X-Fsus-Release-Slot`; the full commit remains restricted to protected
operations/readiness detail. Dependency and worker status semantics,
recent-error cleanup/grouping, queue counts, route permissions, fixed-IP
limiting, and audit events are unchanged.

Rollback requires no database or runtime-state migration. Operators can route
traffic back to the previous immutable slot without restarting the active slot;
the previous slot reports its own provider snapshot and assembly mirror.
