# Blue/Green deployment runbook

This runbook is the current authority for slot lifecycle, atomic gateway switching and rollback coordination. It describes required behavior; a completed rollout is proven only by release-bound execution receipts.

## Slot model

<!-- fsus-doc-claim
claimId: deployment.blue-green-contract
behaviorId: browserless-production-correctness
claimType: generated-section
generatedSectionId: deployment.blue-green-contract
render: key-value-table
anchor: slot-model
-->
<!-- FSUSBLOG-GENERATED:BEGIN deployment.blue-green-contract -->
| Key | Value |
| --- | --- |
| activeIdentityFields | ["activeImageDigest","activeReleaseId","activeSlot"] |
| activeStopRejected | true |
| destructiveCleanupExclusions | ["active-artifact","active-process","active-runtime","shared-schema","shared-volume"] |
| failureSemantics | preserve-or-restore-active-identity |
| operations | ["bootstrap","rollback","switch"] |
| pendingTransitionPreservesActive | true |
| slots | ["blue","green"] |
| stableStates | ["stable"] |
| standbyIdentityFields | ["imageDigest","releaseId","slot"] |
| stateSchema | fsusblog.deployment-slots.v1 |
| switchCommitsTargetIdentity | true |
| transitionStates | ["rollback_required","switching"] |
| unknownActiveIdentityPolicy | fail-closed |
<!-- FSUSBLOG-GENERATED:END deployment.blue-green-contract -->

Only `blue` and `green` are valid slots. Each slot has a distinct loopback port, Compose project, container name, immutable release identity, runtime generation and instance-local log/cache/temp roots. PostgreSQL, Redis, uploads, DataProtection keys and append-only release storage remain shared according to their own lifecycle contracts.

A slot progresses through `Starting -> Candidate -> Ready -> Active -> Draining -> Stopped`. Readiness requires a positive runtime generation plus startup, dependency, schema compatibility, release identity and storage checks. Repeating the same valid transition is idempotent; an identity or generation mismatch fails closed.

Before candidate start, `slot-preflight.sh` verifies host capacity, ports, shared mounts/network, drain versus stop-grace timing, the exact image digest and runtime labels. Candidate failure never stops the active slot. Stopping an active slot is forbidden.

## Gateway switch

OpenResty reads one controlled loopback upstream from `active-upstream.conf`. The gateway controller:

1. holds the host deployment lock;
2. verifies durable source identity and target Ready Candidate identity;
3. stages and validates a complete gateway configuration;
4. activates the target with release/slot/generation compare-and-swap;
5. atomically installs the include and reloads OpenResty;
6. verifies loopback and public release headers;
7. commits durable traffic state, then begins source drain.

Before durable traffic commit, any reload or verification failure restores and retests the source include and neutralizes the target. After commit, the target remains Active while source drain completes; incomplete drain blocks closeout but is not rewritten as a failed traffic switch.

## Drain contract

Draining immediately rejects new ordinary requests, notification handshakes and global worker claims while preserving in-flight accounting. Health and ops probes are excluded from ordinary request leases. Notification connections and worker claims use their own admission counters.

The drain coordinator executes registered participants in parallel under individual and global deadlines. Evidence reports exact pending counts, errors and replay sources. A timeout remains `drained=false,timedOut=true`; a hard stop or missing process is never proof of drain.

Notification restart uses WebSocket 1012 with cursor preservation. Replay outside the retention window uses 4009 and requires full resynchronization. Binary endpoints retain their AEDS contract throughout slot transitions.

## Active fence and storage gates

Traffic commit does not authorize old-generation singleton writes. The target must acquire the active release fence and the source must be revoked; every irreversible worker boundary rechecks its active ticket. The detailed owner and failure rules are in [active release fencing](../active-release-fencing.md).

Before switching, release assets are materialized append-only and N/N-1 compatibility, retained asset hashes and storage lifecycle checks pass. The storage authority is [release storage lifecycle](../architecture/release-storage-lifecycle.md).

Schema changes follow Expand/Backfill/Contract and the candidate must pass [online database migration](../online-database-migration.md) compatibility before Ready.

## Rollback and recovery

- Before traffic commit: keep source Active, restore its gateway include, revoke/neutralize the candidate and preserve failure receipts.
- After traffic commit: use the retained previous manifest as a fresh Ready Candidate. A Draining process is not reactivated.
- After a non-rollback-compatible Contract migration: block old-image rollback and use write isolation plus backup/forward repair.
- On interrupted state: `gateway-recover.sh` reconciles durable state, the installed include and observed identity. It must not guess from process names or mutable tags.

Rollback always advances generation monotonically. Database downgrade is outside the gateway control plane.

## Receipt boundary

Slot status, preflight output, gateway transition, fence ownership, notification restart, source drain and rollback are execution receipts. They belong to the run-scoped release evidence bundle, not this document. The receipt must bind the same release manifest, full commit, image digest, rollout ID and target environment; absent or failed steps stay absent or failed.

## Local validation

```bash
node --test tests/tools/deployment-slots.test.mjs tests/tools/gateway-switch.test.mjs
node tools/run-test-matrix.mjs validate
```

Local validation checks contracts and fixtures only. It does not start production slots or switch live traffic.
## Current production bundle ordering

<!-- fsus-doc-claim
claimId: browserless-production-correctness.bundle-order
behaviorId: browserless-production-correctness
claimType: generated-section
generatedSectionId: release.production-bundle-order
render: key-value-table
-->

<!-- FSUSBLOG-GENERATED:BEGIN release.production-bundle-order -->
| Key | Value |
| --- | --- |
| bundleIds | ["backend-tests","build-static","frontend-tests","performance-evidence","runtime-browser"] |
| edges | ["backend-tests->performance-evidence","build-static->performance-evidence","frontend-tests->performance-evidence","runtime-browser->performance-evidence"] |
| hasDependencyEdges | true |
| profileId | production |
| topoOrderConstraints | ["after:performance-evidence\|requires:backend-tests","after:performance-evidence\|requires:build-static","after:performance-evidence\|requires:frontend-tests","after:performance-evidence\|requires:runtime-browser"] |
<!-- FSUSBLOG-GENERATED:END release.production-bundle-order -->
