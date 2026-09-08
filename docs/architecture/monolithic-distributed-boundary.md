# Monolithic distributed architecture boundary

FsusBlog is **monolithic distributed** (Homogeneous Binary, Heterogeneous Runtime): the repository, build, and deployment always produce one FsusBlog program, with `FsusBlog.Server` as the sole business entry point. Multiple nodes change only which runtime responsibilities each instance performs; content, comments, search, and other modules never become separate business services.

## Invariants

- One repository, primary application project, application Dockerfile, and integrated frontend/backend production artifact.
- PostgreSQL, Redis, and an optional gateway are infrastructure/deployment layers, not split business sidecars.
- Single-node is the default; every multi-node member still runs the same binary and module set.
- Domain modules express business capabilities without knowing node location, HTTP/gRPC clients, or Redis transport.
- Cross-node execution enters remote invocation only through a narrow port/adapter; callers try local capability first and the runtime decides whether to delegate remotely.

## Runtime modes

The sole runtime-mode authority is the compiled `RuntimeModeOptions` observation. The modes are `single`, `static-role`, and `adaptive`; the generated section below owns responsibility combinations and unsupported combinations, so this document keeps no hand-maintained mode table or second role map.

<!-- fsus-doc-claim
claimId: deployment-blue-green-runtime-role.runtime-roles
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: deployment.runtime-roles
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN deployment.runtime-roles -->
| Key | Value |
| --- | --- |
| artifactDigest | 2daec8debec316450e9c2f1f578755233b908077727302c5044f7eb4388197b1 |
| modes | {"adaptive":{"adaptiveSchedulerEnabled":true,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"single":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":false,"distributedInvalidationEnabled":false,"localInvocationOnly":true,"roleCombinationState":"optional-ignored","staticRoles":["none"]},"static-role":{"adaptiveSchedulerEnabled":false,"clusterMembershipEnabled":true,"distributedInvalidationEnabled":true,"localInvocationOnly":true,"roleCombinationState":"explicit-required","staticRoles":["audit","content","maintenance","security","web"]}} |
| observationDigest | e1eb2f48af35e82ee05e5733aa4bc3d2b5bb3f9309f2fd5a1463a94452027363 |
| ownership | {"authorityState":"conflict-unknown","coResidency":"local-invocation-only","container":"not-expressed-by-runtime-authority","process":"not-expressed-by-runtime-authority","separation":"not-expressed-by-runtime-authority","service":"not-expressed-by-runtime-authority"} |
| schema | fsusblog.runtime-role-observation.v1 |
| staticRoleCapabilities | {"audit":["comment.audit"],"content":["media.processor","search.indexer"],"maintenance":["media.processor","scheduler.worker"],"security":["antispam.inference","comment.audit"],"web":["admin.ui","comment.api","search.query","web.api"]} |
| unsupportedCombinations | {"static-role-empty":"runtime_static_roles_required","static-role-unknown":"runtime_static_role_invalid:unknown","unknown-mode":"runtime_mode_invalid:unsupported"} |
<!-- FSUSBLOG-GENERATED:END deployment.runtime-roles -->

All three modes use the same FsusBlog program and artifact. During a transient remote-dependency failure, nodes retain local invalidation and authoritative-data fallback while transport retries; no business artifact switch is required. To disable cluster components completely, set `Runtime:Mode` back to `single` and rolling-restart because hosted-service DI composition is fixed at startup. In `single`, the local publisher branch must register before Redis transport so no remote hot path exists.

## Project and deployment-topology guard

The static guard treats `src/backend/FsusBlog.Server.csproj`, `ops/docker/FsusBlog.Server.Dockerfile`, and the Compose service manifest as authoritative:

- `src/` may contain only one Web/Exe business-entry project; Core/Shared remain libraries.
- `FsusBlog.Server.csproj` must copy frontend dist into its own `wwwroot`; an independent frontend production artifact is forbidden.
- Compose may declare only classified application, gateway, or infrastructure services; a new required business sidecar fails immediately.
- Domain roots may not import HTTP, gRPC, Redis, sockets, or node-location implementations.
- Remote-invocation identifiers may appear only in Interfaces, Contracts, or Infrastructure port/adapter roots.

Run locally:
```bash
node tools/governance/check-monolithic-distributed-architecture.mjs
node --test tests/tools/monolithic-distributed-architecture.test.mjs
node tools/run-test-matrix.mjs validate
```

For a false-positive guard result, keep the existing single-application artifact and roll back the new Compose/project entry. If a remote adapter fails, existing local invalidation and authoritative-data fallback continue without restart; fully disabling cluster capability follows the `single` rolling restart above and changes neither API contracts nor artifact shape.

## Distributed Runtime issue boundary

These issues extend the same application; they do not define fixed service splits:

- #110 monolithic distributed support: homogeneous full-capability nodes and dynamic responsibility scheduling
- #111 node capability registration and cluster-membership governance
- #112 dynamic responsibility scheduling and adaptive load balancing
- #113 distributed state control
- #114 transparent local/remote invocation switching and module-boundary constraints
- #115 multi-node deployment, observability, and failure governance

Capability registration, responsibility scheduling, state coordination, transparent invocation, and failure governance may evolve independently, but all remain subject to one program, one artifact, and one business-entry boundary.
## Current execution classes

<!-- fsus-doc-claim
claimId: browserless-production-correctness.execution-classes
behaviorId: browserless-production-correctness
claimType: generated-section
generatedSectionId: testing.execution-classes
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN testing.execution-classes -->
| Key | Value |
| --- | --- |
| byEvidenceClass | {"browser-contract":"correctness","correctness":"correctness","diagnostic":"diagnostic"} |
| qualificationEligible | {"browser-contract":true,"correctness":true,"diagnostic":false} |
| requires | {"browser-contract":["producerId","schedulerRunId","sourceIdentity"],"correctness":["producerId","schedulerRunId","sourceIdentity"]} |
<!-- FSUSBLOG-GENERATED:END testing.execution-classes -->
