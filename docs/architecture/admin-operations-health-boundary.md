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

The historical schema migration column `app_version` is an audit mirror, not a
schema compatibility coordinate or a release-ID migration selector. Current-schema
admission uses the shared current receipt and the original fresh read-only Server
observer, not the retired online compatibility fence or N/N-1 window.

Protected production readiness detail uses `currentSchema`. Readiness requires
the published startup admission, exact receipt artifact and deployment candidate
bindings, and a fresh current target/database observation through the same receipt
admission API. Missing state, malformed artifacts, binding or observation drift,
and unavailable observers fail closed. Matching metadata alone and old online
runtime reports cannot grant readiness. Real-provider and performance acceptance
of this observation remain separate gates.

The public readiness body contains `status` and `checkedAt`, with only the stable
`schema_incompatible` code on current-schema admission failure. Receipt paths,
database identity, candidate and schema digests remain protected. Public responses
continue to expose only `X-Fsus-Release-Id` and `X-Fsus-Release-Slot`; the full commit
remains restricted to protected operations/readiness detail. Dependency and worker
status semantics, recent-error cleanup/grouping, queue counts, route permissions,
fixed-IP limiting, and audit events are unchanged.

Recovery permits an unactivated candidate fallback, a verified matching backup
restore followed by fresh current-schema verification, or a forward fix. Routing
an old image onto an already migrated database is not recovery. An activation
whose response is lost must not automatically restore or drain the old source;
operators must resolve the actual runtime and database observations first.
