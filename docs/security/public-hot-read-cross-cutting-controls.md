# PublicHotRead Cross-Cutting Controls and Rollback Runbook

## Purpose

`PublicHotRead` returns pre-generated public bytes before the routing/endpoint pipeline. `PublicHotReadCrossCuttingControlCatalog` is the source of truth for control coverage across the early and ordinary endpoint branches; the route allowlist remains owned by `PublicHotReadRouteSecurityCatalog`. Adding or moving a cross-cutting control requires both catalogs, runtime stage, synthetic endpoint metadata, focused behavior tests, and the CI checker to change together.

## Coverage patterns

| Pattern | Current controls | Constraint |
| ------ | ---------- | ------ |
| `global-before-branch` | release/security headers, deployment tracking, Shield/exception/binary boundary, trace correlation | Executes exactly once before the classifier; fast and canonical paths share it automatically. |
| `early-replayed` | `public_read` limiter, lightweight request audit context | Must be registered on both early and endpoint paths; request execution state prevents a miss fallback from duplicating the lease/context. |
| `endpoint-only/not-applicable` | CORS, antiforgery/CSRF, anonymous gateway header guard, authentication, banned-user, authorization | Must bind executable constraints: exact allowlist, anonymous/no credentials, no gateway-rejected `X-Fsus-*` header, no `Origin`, and `GET`/`HEAD` only; prose exemptions are insufficient. |

Request audit context adds only trace/path/method and already-present actor fields to logging context; it performs no persistent audit write, database/Redis query, or actor lookup. High-value audit remains triggered only by the original endpoint/service semantics.

Every stage in `s_applicationPipelineStages` and `s_endpointPipelineStages` must explicitly be classified as `Infrastructure`, `BranchMechanic`, `EndpointFunctional`, or `CrossCuttingControl`. Only `CrossCuttingControl` may declare a control ID, and each ID/stage must match this catalog in both directions, one-to-one. Non-catalog stages such as forwarded headers, test-session validation, routing, endpoint metadata headers, WebSocket, and compression/output cache still require classification. A security stage added only to the pipeline without catalog registration therefore makes startup validation and the CI self-test fail closed.

## Change procedure

1. Register a stable control ID, coverage pattern, and stage in `PublicHotReadCrossCuttingControlCatalog`; every replayed control needs a unique double-execution guard.
2. If a control does not apply to L0, first record an executable predicate and route-policy/endpoint-metadata evidence in the classifier/catalog; do not add `NotApplicableEvidenceId` and rely on prose.
3. Update `s_applicationPipelineStages` and/or `s_endpointPipelineStages` with an explicit classification for each new stage; security/cross-cutting stages must also carry the catalog's control ID. Startup validation must still run before any stage is registered.
4. Update request-level tests for anonymous fast hit, authenticated credential bypass, admin/author, notification stream, dynamic binary, `Origin`/unsafe method, and real miss fallback. Output changes must also compare raw bytes with the production-mapped canonical endpoint.
5. Update visibility tests: only-Published admission must reject each of `Draft`, `Scheduled`, `Archived`, `Deleted`, `IsDeleted=true`, future `PublishedAt`, and future `ScheduledPublishAt`.
6. Run:

   ```bash
   node tools/check-public-hot-read-cross-cutting-controls.mjs --self-test
   bash tools/check-public-hot-read-fastpath.sh
   dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter FullyQualifiedName~PublicHotReadCrossCuttingControlTests
   ```

## Fail-closed behavior and rollback

- Drift in the catalog, stage, guard, route policy, metadata, or executable probe fails application startup. Keep the active release; do not remove validation or temporarily mark the control not applicable.
- If runtime classifier/bypass errors, byte-parity failure, invalid visibility evidence, or an unknown route occurs, set `PublicHotRead:Enabled=false` through a reload-capable configuration source. The next request stops the extra early feature and all requests return to the normal routing/CORS/authentication/banned-user/authorization/audit chain, without a restart.
- This rollback does not disable public-artifact revocation, release/security headers, Shield, PoW/RiskControl, ordinary rate limiting, or notification streams. An active tombstone still returns `410` first.
- After rollback, inspect `runtime.publicHotRead`, credential/sensitive-bypass counters, and canonical endpoint status at `/api/ops/health/ready-detail`. After repair, run the checker/tests above, confirm snapshot evidence `visibilityPolicy=published-visible-at-cutoff-v1`, `sourceVisibility=public`, and matching source/candidate versions, then hot-reload `PublicHotRead:Enabled=true`.

## Guarantees not provided

This catalog proves the structure and request behavior of the two in-process HTTP pipelines; it does not replace a CDN purge receipt, cross-node snapshot convergence, Redis Pub/Sub subscriber ACK, or external release validation.
