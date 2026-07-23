# Zero-downtime release qualification runbook

This runbook owns the stable orchestration responsibilities for traffic, browser/asset compatibility, notification continuity, worker reconciliation and migration qualification. `tools/deployment/release-rollout.sh` is the production rollout entrypoint; `zero-downtime-rehearsal.sh` is a controlled qualification harness, not a second deployment authority.

## Stable responsibility map

| Responsibility | Contract or scenario owner | Execution receipt owner |
| --- | --- | --- |
| HTTP session and AEDS traffic | `tests/fixtures/deployment/release-traffic-session-scenario.json`, `release-traffic-probe.mjs` | run bundle traffic artifact, verified by `release-traffic-evidence-verify.mjs` |
| Browser and retained assets | `release-asset-browser-scenario.template.json`, [browser contract](../testing/browser-contract.md), [storage compatibility](release-storage-compatibility-matrix.md) | run bundle asset/browser artifact, HMAC verified |
| Notification restart and replay | `release-notification-resync-scenario.template.json`, `release-notification-probe.mjs` | run bundle notification artifact |
| Normal worker completion | `release-worker-normal-observer-plan.template.json`, normal observer tools | run-scoped normal worker ledger |
| Forced-source reconciliation | `release-worker-drill-plan.template.json`, reconciliation tools | independent destructive qualification artifact |
| Schema migration qualification | `release-migration-qualification-scenario.template.json`, [migration operations](../online-database-migration-operations.md) | run bundle qualification artifact |
| End-to-end rehearsal | `zero-downtime-rehearsal-plan.template.json` | run-scoped rehearsal state and sealed evidence bundle |

Tracked templates and tests are schemas/fixtures, never proof that a production run occurred.

## Traffic and asset binding

A rollout uses separate private key files for traffic and asset/browser evidence. Each key is a regular non-symlink mode-0400/0600 file, 32–4096 bytes, and cannot be reused as an admin header, cookie store or the other evidence key. Resume always re-verifies HMAC and content binding; file existence never authorizes reuse.

Traffic scenarios cover anonymous, authenticated and admin chains, AEDS headers/body limits, response hashes and identity allowed by stage. Hold/in-flight scenarios span the real gateway switch and distinguish planned, running and completed states. The verifier binds release identity, gateway generation, switch commit state and artifact digest.

Browser/asset qualification proves N/N-1 frontend/backend compatibility, old Service Worker cache paths and retained immutable URLs before and after GC. A browser checkpoint marked required cannot be replaced by an HTTP-only probe. Cache privacy remains governed by [Service Worker cache boundary](../security/service-worker-cache-boundary.md).

## Notification continuity

The notification scenario proves guest and authenticated 1012 restart, cursor replay, 4009 replay-miss full resync, event deduplication and slow-client drain. Evidence records observed protocol results and release identity; a scenario template or static route declaration is not a receipt.

## Worker qualification

Normal rollout qualification observes the real eight durable work kinds through the Test-only, loopback admin observer service. It requires graceful source drain, exactly-once target effects and zero stale-generation commits. The normal ledger is fresh and belongs to the same rollout identity.

Forced-source/SIGKILL reconciliation is a separate destructive Test topology. It uses a distinct run ID and plan, explicit authorization, process identity proof and read-only/default-safe adapters. It cannot reuse the normal rollout ledger or run inside production source drain. Recovery must show a target-owned final effect count of one and no stale source-generation commit.

Observer and migration bridge routes stay disabled in Production. Their guards require the Test environment, explicit rehearsal enablement, loopback origin, admin `system.config` and fixed-IP policy.

## Migration qualification

Qualification exercises the stable Expand/Backfill/Contract cases, including concurrent N/N-1 reads/writes, checkpoint pause/resume, missing Expand readiness failure, Contract rollback rejection, lock timeout, database disconnect, partial resume and history integrity. It consumes the exact target server artifact and immutable migration IDs.

The harness cannot manufacture production compatibility. A failed or unavailable case remains failed or blocked in the receipt. Production behavior and migration implementation remain owned by the online migration documents and code.

## Resume, faults and rollback

Resume accepts only the same rollout ID, release manifest, target digest, scenario digests, key identities and durable state. It skips only sealed successful stages. Orphan running stages are preserved as interruption failures before their explicit recovery path runs.

Fault cases such as public probe failure, active-fence failure, rollback and source termination remain separate receipts. Rollback uses the blue/green runbook, restores gateway/fence with a newer generation and retains the original failed evidence.

## Evidence closeout

All receipts flow into the model defined by [release evidence](../release-evidence-model.md). A current document may define required fields and failure semantics but may not contain a production run ID, current counter value, timestamped pass claim or unexecuted-task note. External execution can remain pending without blocking repository documentation closure.

## Local validation

```bash
node --test \
  tests/tools/release-traffic-probe-session.test.mjs \
  tests/tools/release-notification-probe.test.mjs \
  tests/tools/release-worker-normal-observer.test.mjs \
  tests/tools/release-worker-reconciliation.test.mjs \
  tests/tools/zero-downtime-rehearsal.test.mjs
```

These tests validate static contracts and controlled fixtures. They do not assert that an external rollout or rehearsal ran.
