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

The endpoint depends on the narrow reader directly. `AdminOperationsService` no
longer owns or forwards health composition and now keeps the integrity use case.
The health reader composes the narrow backup and cache diagnostic ports but
never calls back into that service.

Dependency and worker status semantics, recent-error cleanup/grouping, queue
counts, version resolution, route permissions, fixed-IP limiting, audit events,
and the `OpsHealthResponse` AEDS contract remain unchanged. Rollback requires no
database, runtime-state, or protocol migration.
