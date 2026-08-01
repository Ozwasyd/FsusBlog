# Troubleshooting

This guide covers common public-preview local development failures.

## .NET SDK Version Mismatch

Symptom: `dotnet run` or `dotnet test` fails with an SDK or target framework error.

Likely cause: .NET SDK 10 is missing or an older SDK is first on `PATH`.

How to verify:

```bash
dotnet --version
dotnet --list-sdks
```

Fix: install .NET SDK 10 and reopen the shell so the new SDK is first on `PATH`.

Relevant logs: terminal output from `dotnet run`, `dotnet test`, or `./tools/dev/start.sh`.

## Node / npm / pnpm Version Mismatch

Symptom: `npm ci`, Vite, Vitest, or frontend build fails with engine or lockfile errors.

Likely cause: Node or npm is too old, or pnpm was used against the npm lockfile.

How to verify:

```bash
node --version
npm --version
```

Fix: use Node 20+ and npm 10+. Do not replace `src/frontend/package-lock.json` with a pnpm lockfile unless the project intentionally changes package managers.

Relevant logs: `src/frontend/npm-debug.log`, terminal output from `npm ci`, Vite, or Vitest.

## PostgreSQL Connection Failure

Symptom: backend startup fails with a database connection or migration error.

Likely cause: the dev PostgreSQL container is not running, port `5432` is occupied, or connection environment variables were changed.

How to verify:

```bash
docker compose -f ops/development/dependencies.compose.yml ps
docker exec fsusblog-dev-postgres pg_isready -U fsusblog -d fsusblog
```

Fix: free port `5432`, set `FSUSBLOG_DEV_POSTGRES_PORT` to another local port, or restart the dev dependencies:

```bash
docker compose -f ops/development/dependencies.compose.yml up -d postgres
```

Relevant logs: backend console logs and `docker logs fsusblog-dev-postgres`.

## Redis Connection Failure

Symptom: backend startup, PoW, session, notification, or cache flows fail with Redis connection errors.

Likely cause: Redis is not running, port `6379` is occupied, or the Redis connection string points to the wrong host.

How to verify:

```bash
docker compose -f ops/development/dependencies.compose.yml ps
docker exec fsusblog-dev-redis redis-cli ping
```

Fix: free port `6379`, set `FSUSBLOG_DEV_REDIS_PORT`, or restart Redis:

```bash
docker compose -f ops/development/dependencies.compose.yml up -d redis
```

Relevant logs: backend console logs and `docker logs fsusblog-dev-redis`.

## Port Conflicts

Symptom: PostgreSQL, Redis, backend, or frontend cannot bind to a port.

Likely cause: another local service is already using `5432`, `6379`, `7568`, or `3000`.

How to verify:

```bash
lsof -i :5432
lsof -i :6379
lsof -i :7568
lsof -i :3000
```

Fix: stop the conflicting process, change `FSUSBLOG_DEV_POSTGRES_PORT` / `FSUSBLOG_DEV_REDIS_PORT`, or adjust backend/frontend ports for the current shell.

Relevant logs: terminal output from Docker, ASP.NET Core, or Vite.

## Frontend Dev Server Proxy Failure

Symptom: the Vite page loads, but API calls fail with network errors or `502`.

Likely cause: backend is not running on `http://127.0.0.1:7568` or Vite proxy configuration points at a different target.

How to verify:

```bash
curl -i http://127.0.0.1:7568/health/live
```

Fix: start the backend with `./tools/dev/start.sh`, or update the local Vite proxy only for the current development environment.

Relevant logs: browser console, Vite terminal, backend terminal.

## AEDS Decode / WASM Worker Issue

Symptom: public pages or admin calls fail after receiving binary responses; console mentions AEDS, Wasm, worker, or decode failure.

Likely cause: Wasm artifacts are missing, stale, or blocked by the browser.

How to verify:

```bash
cd src/frontend
npm run ensure:wasm
```

Fix: regenerate or refresh Wasm artifacts with `npm run ensure:wasm`; for local Wasm development, rebuild with the documented Emscripten flow in [docs/wasm.md](wasm.md).

Relevant logs: browser console, `wasmDecode.worker.ts` debug output, Vite terminal.

## WebAuthn RP ID / Origin Configuration Issue

Symptom: Passkey registration or login fails with RP ID, origin, or WebAuthn ceremony errors.

Likely cause: the browser origin does not match `Fido2:ServerDomain` and `Fido2:Origins`.

How to verify:

```bash
curl -s http://127.0.0.1:7568/health/live
```

Then confirm the frontend is opened at `http://localhost:3000` or `http://127.0.0.1:3000`.

Fix: use the documented local URLs, or set matching `Fido2__ServerDomain` and `Fido2__Origins__*` environment variables before backend startup.

For local automation, inject a WebAuthn virtual authenticator into the browser
context before running the Passkey ceremony. The authenticator injection is only
browser-side state; the server credential must still be created through normal
Passkey registration or admin bootstrap endpoints. See
[docs/development.md](development.md#本地-passkey-注入).

Relevant logs: browser console and backend auth logs.

## Login / Session / Cookie Issues

Symptom: login succeeds but the UI behaves as logged out, refresh fails, or cookies are missing.

Likely cause: origin mismatch, blocked third-party cookies, stale cookies, or insecure local HTTP cookie settings.

How to verify: inspect browser devtools Application/Storage cookies for `localhost` and `127.0.0.1`.

Fix: clear local cookies for both origins, use one consistent origin, and start through `./tools/dev/start.sh` so local insecure transport cookie settings are applied for development.

Relevant logs: browser network panel, backend auth logs.

## Migration Failure

Symptom: backend starts but reports missing tables, duplicate indexes, or schema migration errors.

Likely cause: interrupted CodeFirst migration, stale local volume, or a schema created by an incompatible branch.

How to verify:

```bash
docker logs fsusblog-dev-postgres
```

Fix: for disposable local data, reset the dev volumes:

```bash
./tools/dev/start.sh --cleanup
./tools/dev/start.sh --fixture-profile demo-public
```

Relevant logs: backend startup logs and PostgreSQL logs.

## Public AOT Worker Failure

Symptom: public pages fall back to SPA shell, AOT cache stays empty, or logs mention Public AOT renderer failure.

Likely cause: frontend SSR bundle is stale, Node is missing, or the AOT worker cannot write cache files.

How to verify:

```bash
npm --prefix src/frontend run build:release
```

Fix: rebuild frontend assets, confirm Node is available, and ensure the backend process can write its local data/cache directory.

Relevant logs: backend PublicAOT logs, frontend build logs, `.tmp` or backend data-root logs if configured.

## Issue Orchestration Ledger Or Projection Failure

Symptom: orchestration refuses to dispatch with `ledger-tail-corrupt`, `ledger-hash-chain`, `event-payload-digest`, `event-digest`, `dag-projection-mismatch`, or `ledger-sequence`.

Likely cause: the external JSONL ledger was truncated, reordered, edited, or written with a projection that is ahead of the durable event prefix.

How to verify: preserve the state root and inspect the reported `lastValidSequence`, `lastEventDigest`, `runId`, `baseSha`, and `projectionDigest`. Do not delete, truncate, reorder, or hand-edit a historical event. A correction is a new `ledger.correction-recorded` event referencing the original event ID and digest.

Fix: stop dispatch and ask the root scheduler to run the ledger recovery path. A missing or stale projection is rebuilt by replaying the durable ledger; a projection ahead of the ledger is discarded and rebuilt. A corrupt tail remains fail-closed until the tail is repaired through the normal append/correction procedure. Recovery must report `projection-already-current` when no write is needed and must not repeat an already recorded attempt, delivery, commit, or cleanup side effect.

Relevant evidence: the state-root recovery receipt, the final valid sequence, the projection digest, and the preserved ledger bytes. The ledger must remain outside both product repositories, the shared workspace, and every worktree.

## Issue Orchestration Receipt Or Permission Rejection

Symptom: `verified-dispatch-receipt-required`, `verified-self-test-receipt-required`, `receipt-schema-stage-mismatch`, `candidate-tests-not-green`, `candidate-visible-matrix-incomplete`, `frozen-test-contract-modified`, `independent-verification-not-fresh`, `candidate-identity-mismatch`, `first-failure-mismatch`, `ledger-writer-role`, `state-root-protected-overlap`, or `ledger-path-symlink`.

Likely cause: implementation started without a verified dispatch receipt, candidate-green used the legacy `verified-candidate-receipt.v1` instead of `implementer-self-test-receipt.v1`, an implementer receipt is incomplete or stale, an independent verifier is not fresh or is checking a different candidate SHA, a later stage attempted to erase the first failure, or a non-root actor tried to write the ledger/path.

How to verify: compare the dispatch receipt's request/runtime metadata digest, effective model/effort/role/sandbox/fork/cwd, loaded Skill digests, candidate SHA, actor identity, frozen test-contract digest, visible-matrix result, self-test cycles, first-failure evidence, and modified-path list with the event payload and current run identity. Confirm that the writer is `root-scheduler` and that the canonical state root has no protected-root overlap or symlink escape.

Fix: keep the same implementation attempt for internal red/green cycles; do not increment global `reworkCount` for those private cycles. Only an independent verification rejection may increment it, exactly once, and it must retain the original failure evidence. Reissue a fresh dispatch/self-test receipt for the unchanged candidate or return to the explicitly bound continuation attempt. Do not bypass the rejection by writing `candidate-green`, `behavior-green`, `documentation-green`, or a direct DAG status.

Relevant evidence: the verified implementer self-test receipt, verified dispatch receipt, independent verifier receipt, event digest chain, state-root validation result, and the machine rejection code. A rejection caused by unchanged identity, permissions, or evidence is not fixed by retrying the same request.

## Issue Orchestration Dispatch Runtime Failure

Symptom: `runtime-model-unobservable`, `runtime-effort-unobservable`, `runtime-role-unobservable`, `runtime-sandbox-unobservable`, `runtime-fork-unobservable`, `runtime-working-directory-unobservable`, `runtime-prompt-digest-mismatch`, `runtime-base-sha-mismatch`, `runtime-candidate-identity-mismatch`, `runtime-required-skill-missing`, `runtime-skill-digest-mismatch`, `runtime-provenance-request-copy`, `dispatch-stage-profile-policy`, `dispatch-ui-design-authority-policy`, `dispatch-secret-material`, `dispatch-receipt-replay`, or a `routing-*` rejection such as `routing-policy-version`, `routing-classification-field`, `routing-selected-profile`, `routing-permission`, `routing-ui-adjudication-required`, `routing-verifier-fresh-context`, or `runtime-capability-missing`.

Likely cause: the child rollout did not expose effective metadata, the runtime was copied from the request instead of observed, the child inherited a different model/effort/sandbox/fork/cwd, a required Skill was not loaded from machine evidence, a candidate/request/epoch identity drifted, or a secret-bearing observation was supplied.

How to verify: preserve the external state root and run the deterministic verifier with the original files:

```bash
node .agents/skills/issue-orchestration/scripts/dispatch-receipt.mjs verify-runtime \
  --request <state-root>/requests/<request-id>.json \
  --rollout <runtime-rollout-jsonl> \
  --machine-observations <state-root>/observations/<request-id>.json
```

Inspect `runtime-observation.v1` effective fields, `skill-loader` source/digests, git candidate/base identity, lease identity, `mismatchReasons`, and `verificationStatus`. `capability-unverified` means a required observation is unavailable; `rejected` means an observed identity/policy/evidence mismatch. Neither status permits `implementation.started`. Do not use agent self-report or requested fields as a fallback.

Fix: stop the attempt, preserve the receipt and first failure, and correct the dispatch boundary or produce a new request with a new attempt/epoch/thread identity after the relevant runtime or candidate change. Do not retry an unchanged request, rollout, sandbox, Skill load, or state root. Behavior/UX verifier and UI adjudicator requests must remain read-only; test-owner test-contract writes must remain inside the scoped tests/fixtures lease.

If the rejection is a `routing-*` code, inspect the `issue-orchestration.stage-assignment.v2` against the single `issue-orchestration.stage-model-pool-policy.v2` manifest (`stage-model-pool.v2`). Recompute the mandatory classification fields and `modelRoutingEvidenceDigest`, then verify the exact stage role/phase, allowed/default/selected profile, routing input digest, sandbox/write scope, required Skill digests and capability digest. Root is always `luna-low`; DAG, test-owner, code, UI, adjudicator, UX and documentation profiles are selected only by the deterministic compiler. Replace legacy issue implementer/reviewer/cleanup-verifier aliases and node-local model/effort fields; no compatibility fallback is valid. A missing selected profile must return `runtime-capability-missing`, never silently switch model or effort. A `system-design-dispute` must stop UI implementation and route to a fresh read-only `ui-system-adjudicator`; adjudication cannot grant write access or sign UX acceptance.

## Issue Orchestration Layered Investigation Rejection

Symptom: frontier compilation refuses to dispatch with `legacy-investigation-schema-forbidden`, `investigation-projection-unvalidated`, `investigation-projection-schema`, `investigation-validation-authority`, `investigation-projection-member-duplicate`, `investigation-projection-derived-list-mismatch`, `investigation-projection-digest-mismatch`, `selector-receipt-mismatch`, `investigation-projection-stale`, `investigation-layer-schema`, `investigation-layer-status`, `investigation-layer-digest-mismatch`, `investigation-layer-authority`, `investigation-layer-input-digest-mismatch`, or `issue-facts-stale`.

Likely cause: the discovery/classification/dispatch investigation chain is missing, unsigned with the wrong authority, stale against the live selector or remote facts, incomplete for the requested stage, or still carries the retired `node.investigation` authority.

How to verify: preserve the candidate and current state root, then compare every member in `issue-orchestration.investigation-projection.v1` with the current selector receipt. Check the exact validation schema and machine read-only validator, one projection member per DAG node, recomputed layer digests and input digests, the non-root `dag-creator-updater` identity shared by discovery/classification, the frozen `test-owner` identity and `testOwnerId` for dispatch, freshness member digests, and dispatch `baseSha`. Confirm that no production path reads or falls back to `node.investigation`.

Fix: regenerate the layered facts and projection from the current live selector/remote snapshot, re-run the read-only validation, and compile a new frontier. A `candidate-ready` member may enter only `test-contract-ready`; later stages remain blocked with compiler-owned `investigation-incomplete` evidence until `dispatch-investigated` is complete. Do not re-sign an altered envelope, reuse a stale projection, or restore the retired full-investigation field as a compatibility fallback.

If dispatch evidence is rejected after a base, epoch, AGENTS, current-doc, owner-code, or test-entry change, rebuild only that member's dispatch layer. Issue/comment drift invalidates that member's discovery/classification chain; unrelated members retain unchanged layers. Do not clear and rebuild the full scope, pad missing paths with `TODO`/`N/A`, let group evidence replace a member contract, or let background investigation suppress machine-ready work.

Relevant evidence: the layered investigation projection and validation receipt, discovery/classification/dispatch layer digests, selector and remote snapshot digests, freshness member-fact digests, stage blocker evidence, investigation queue explanation, member-specific group evidence, and the current frontier projection. If any identity or digest is unchanged and still rejected, do not retry the same request.

## Issue Orchestration Dispatch Batch Rejection

Symptom: orchestration refuses to dispatch with `dispatch-projection-required`, `dispatch-projection-incomplete`, `dispatch-frontier-binding`, `ranking-policy-schema`, `batch-not-maximal`, `batch-selection-mismatch`, `batch-write-conflict`, `batch-worktree-write-conflict`, `batch-resource-conflict`, `conflict-key-evidence`, or `semantic-conflict-conflation`.

Likely cause: the six-field frontier/dispatch unit is missing or partial, dispatch tasks drifted from the verified frontier/DAG facts, a recorded batch omitted a task that could safely fill an idle slot, exceeded available slots, reordered deterministic rank, co-selected conflicting writers/resources, inferred a conflict from an uninvestigated path prefix, or encoded serialization as a semantic dependency.

How to verify: preserve the state root and independently recompute the dispatch frontier and `critical-unlock-conflict.v1` batch from the same selector receipt, verified frontier, runtime slots, active leases, and group proposals. Compare selected/deferred task IDs, strict priority and within-priority rank components, conflict/resource evidence digests, structured defer reasons, `frontierDigest`, and `batchDigest`. Confirm that conflict keys come from investigated owner/write surfaces or explicit runtime requirements and that the effective slot count is the lower current scheduler/runtime limit.

Fix: regenerate the bound dispatch frontier and batch from unchanged machine facts, or refresh the specific stale frontier, lease, candidate, or investigation evidence first. Do not hand-sort by issue number/input order, delete a conflicting ready task, turn a write conflict into a dependency, globally freeze unrelated work for one long task or root-only delivery, or edit a recorded reason/digest. An unchanged rejected batch must not be retried.

Relevant evidence: the verified frontier projection, dispatch frontier, versioned ranking policy, active lease receipts, acceptance-group qualification evidence, selected/deferred explanations, and independently recomputed batch digest.

## Trusted History Or Current-Run Artifact CI Failure

Symptom: Change Contract cannot resolve a blame-ignore revision/parent; release evidence reports missing data-scale evidence, incomplete current-run identity, or a run identity mismatch; or a primary frontend Quality Gate job cannot download a complete `wasm-build-artifacts` package.

Likely cause: the trusted base/before checkout is shallow, release evidence did not depend on current plan authority, the current `integration-runtime` artifact was not downloaded, a scale summary belongs to another commit/run/attempt/producer, or the current-run Wasm producer was skipped, failed, or uploaded a package without its manifest and receipt.

How to verify: confirm trusted checkout uses `fetch-depth: 0` at the exact PR base or push-before SHA. For scale evidence compare summary `runIdentity.{commit,runId,runAttempt,producerJob}` with `GITHUB_SHA`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, and `integration-runtime`. For Wasm evidence confirm the single `wasm-build-artifacts` producer completed in the same workflow run, uploaded the generated manifest and receipt with the package, and every frontend consumer depends on and downloads that named artifact.

Fix: rerun only after correcting checkout depth or current-run artifact wiring. Do not use candidate-controlled checker code, synthesize missing identity, reuse a historical artifact, soften a required summary, rebuild Wasm independently in a consumer, accept a receipt without its manifest, or retry an unchanged workflow SHA/configuration.

Relevant evidence: trusted checkout SHA and reachable objects, plan artifact, integration-runtime artifact metadata, scale summary run identity, `wasm-build-artifacts` producer/upload/download metadata, and release-evidence job run/attempt.

## Issue Orchestration Resource Cleanup Or Recovery Failure

Symptom: cleanup reports `resource-registry-schema`, `internal-red-attempt-rebuild-forbidden`, `machine-cleanup-verifier-required`, `cleanup-post-inventory-required`, `cleanup-post-inventory-not-empty`, `cleanup-receipt-digest`, `quarantined-dirty`, or `cleanup-failed`.

Likely cause: an internal red cycle rebuilt the attempt/worktree, candidate-green retained the writer, cleanup lacked machine post-inventory, a dirty worktree was targeted for force removal, member cleanup touched group resources, or crash recovery found an orphan/unknown owner or missing external resource.

How to verify: compare resource registry pre/post inventory, attempt/worktree/slot/writer identities, candidate read lease, service descendants/ports, owner class, group/member cleanup order, first-failure refs, and cleanup receipt digest.

Fix: cleanup and quiescence are deterministic machine operations, not an LLM stage. Quarantine dirty state without removal; restore exact ownership or complete machine-observed cleanup, then issue a fresh receipt from the machine resource verifier. Luna/low or Terra/max may explain an anomaly but cannot sign `resources-clean`. Retain group-owned resources until group cleanup, preserve externally-owned resources, and fail closed on every orphan.

Relevant evidence: resource registry, ledger transition, inventories, cleanup receipt, quarantine record, group session digest, process/port observations, and recovery failed/retained lists.

## Permission / File Path Issues On Linux, macOS, Or Windows

Symptom: build, upload, AOT cache, logs, or Docker volume writes fail with permission denied or path errors.

Likely cause: mixed host/container ownership, Windows path conversion, readonly checkout, or a stale Docker volume.

How to verify:

```bash
git status --short
docker compose -f ops/development/dependencies.compose.yml ps
```

Fix: keep the repo in a normal writable workspace, avoid running package managers as root, reset disposable dev volumes when needed, and use WSL2/Linux paths for Docker-heavy workflows on Windows.

Relevant logs: shell output, Docker logs, backend file I/O exceptions.
