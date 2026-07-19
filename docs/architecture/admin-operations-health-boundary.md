# Admin operations health boundary

`IAdminOperationsHealthReader` owns the production operations health read model:

```text
GET /api/binary/admin/ops/health
  -> IAdminOperationsHealthReader
       -> production readiness and runtime state snapshots
       -> backup and search diagnostics readers
       -> queue backlog and recent error projections
       -> environment/version/commit identity
```

The endpoint depends on the narrow reader directly. `AdminIntegrityOperations`
does not own or forward health composition. The health reader composes the
narrow backup and cache diagnostic ports but never calls back into integrity
operations.

Dependency and worker status semantics, recent-error cleanup/grouping, queue
counts, version resolution, route permissions, fixed-IP limiting, audit events,
and the `OpsHealthResponse` AEDS contract remain unchanged. Rollback requires no
database, runtime-state, or protocol migration.
