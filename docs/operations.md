# FsusBlog Operations Runbook

## Task-owned local source preservation

Local preservation tools live in `tools/operations/`; they do not establish runtime,
release, merge, or issue acceptance. Their default mode is read-only `inspect`.
Each invocation requires `--plan PATH --plan-sha256 SHA256`; plans are regular,
current-user-owned files inside their canonical `taskRoot`, use the closed
`fsusblog.local-task-plan.v1` schema, and bind the actual source identities and
operation budgets. Unknown keys, symlink ancestors, changed plan bytes, and
out-of-task output paths are refused. A plan is an input binding, not authorization:
the operator must already own the selected resources and have approval for the
requested effects. Keep production data, shared caches, active worktrees, and
unrelated processes outside the task root.

Launcher and imported-helper SHA inputs bind the current source closure. WIP
preservation separately selects a canonical source repository and registered dirty
worktrees; its task scratch stays outside those source worktrees. Only the reviewed
source repository's new preservation objects/refs and the scratch receipts may be
written. Its explicit `resourceFloor` records current memory/disk admission floors;
neither that record nor a source digest promotes historical evidence to acceptance.

An explicit effect mode also requires the plan's current task lock, held by the
direct `flock -n --close` parent for the operation's complete lifetime. The original
scheduler owns admission, concurrency, memory and disk budgets. Historical dates,
boot IDs, process IDs, VM capacities, and lock names never authorize a new run.
Actual lock ownership does not prove global inactivity; unreadable activity remains
`UNKNOWN`. These tools neither delete remote refs nor close GitHub issues.

| Tool | Preserved behavior and effect boundary |
| --- | --- |
| `archive-compiled-artifacts.mjs` | `inspect` returns the current complete artifact inventory and digest; `archive` requires that frozen digest and current root epoch, preserves originals, creates a new tar and independent restore, and compares file hashes, modes, uid/gid, mtime, links, ACLs and native xattrs. Source and terminal digests are custody inputs, not successful terminal assertions. |
| `retire-idle-materializations.mjs` | `sparse` projects only task-owned linked worktrees through normal worktree-local non-cone Git sparse checkout. The reviewed plan binds HEAD, branch, administrative path, baseline diff, protected roots and original keepers. Shared refs/stash/config/index, logical target index, status, retained bytes and ignored evidence are checked; readable activity or unreadable census refuses mutation. |
| `probe-file-lease-capability.py` | Explicit native mode measures existing/new reader refusal and SIGIO using disposable owned fixtures. File identity and content remain bound; unsupported filesystem leases fail closed. |
| `probe-file-lease-boundaries.py` | Explicit native mode measures direct-FD, mmap, O_PATH and directory limits plus disposable sparse projection. Primary failures survive descriptor/process cleanup failures. A kernel lease is a diagnostic, never an inactivity authority. |
| `recover-failed-run-carrier.mjs` | A current closed carrier plan binds held read-only image descriptors, hashes, epochs, ancestry and original parent receipts before creating an owned recovery carrier. It preserves raw bounded logs and actual cleanup observations; a recovery carrier cannot resume or qualify the failed original checkpoint. |
| `export-failed-run-evidence.mjs` | A current export plan binds the SSH identity and bounded original raw evidence selection. Structured commands retain nonzero status, hashes and terminal uncertainty; historical guest aliases and run IDs are not reusable authority. |
| `guest-preparation-caller.sh` | The thin shell caller delegates to the Node owner, observes exactly one original plan-bound preparation CLI call, source HEAD/tree/index/environment before and after, raw outputs, signals and actual status. It does not substitute a retry or forge an original READY receipt. |
| `wip-publication.mjs` | Inventory covers current branches, stashes and selected dirty worktrees; prepare and dirty snapshots preserve original parents, index and raw bytes. Credential/content and complete-tree path audits precede preservation. Local `.qoder/` is excluded from publication. |
| `wip-catalog-publication.mjs` | Catalog preparation binds all selected source values to their actual preserved parents; explicit `push` uses atomic create-only remote compare-and-swap and verifies current remote reachability and values. Existing refs are preserved. |

Before artifact execution, bind `originalInventorySha256` from the read-only
inventory, rather than permitting a fresh source value at execution. Every
artifact budget is explicit; archive and restore copies remain for investigation
after a failure. Neither a verified archive nor its terminal input permits original
artifact retirement.

Sparse projection saves its original administrative identities, worktree
configuration, patterns, retained inventory and failure phase. A post-mutation
failure stops the batch without automatic rollback. Restore only at the bound HEAD
using the saved worktree configuration and normal Git sparse checkout, then verify
the new physical input closure before admitting builds or tests. Do not remove
ignored evidence or use force-reset as rollback.

Carrier ancestry uses the closed `fsusblog.failed-run-carrier.v2` receipt family.
Every failed parent must preserve its complete image, seed, toolchain file/alias/
directory and share closure before and after. Each later receipt and the current
held inputs must match that exact parent closure. The only allowed image addition
is the parent's own sealed `overlay.qcow2`, recorded with its actual hash, physical
epoch, backing parent and virtual size inside the parent's run directory. An
unrelated failed receipt, omitted ancestor, changed input or partial verification
cannot establish recovery lineage. The producer and consumer use the same closure
shape; consuming a FAILED receipt never inherits qualification.

The original guest caller requires exactly two distinct read-only mount records,
covering its selected SDK and feed paths. Execution rechecks those exact mountpoint
source, filesystem type and `ro` options with `findmnt`; unrelated or duplicate
read-only mounts cannot substitute for writable selected inputs.

The reusable implementations derive from the ten local-tool values in source
commit `1f6068ff7995f9c6bdde2efa9fdaef044ef3d20e`. The archive and sparse source
scripts now have the owners above; both lease scripts retain their complementary
diagnostics; the failed-run/export/guest scripts retain their custody and original
caller controls through current plans; both WIP scripts retain full source catalog
preservation and publication. The old `resource-control.md` contributes stable
ownership, preservation and resource-floor rules here. Its old machine identities,
one-off source selections and historical numeric scheduling limits are obsolete
inputs, not a parallel current scheduling policy.

Controlled fixture verification requires an explicit owned scratch root:

```bash
FSUSBLOG_OPERATIONS_FIXTURE_ROOT=/path/to/owned/scratch NODE_OPTIONS=--max-old-space-size=512 node --test --test-concurrency=1 tests/tools/local-operational-preservation.test.mjs tests/tools/local-operational-carrier.test.mjs tests/tools/local-wip-publication.test.mjs
FSUSBLOG_OPERATIONS_FIXTURE_ROOT=/path/to/owned/scratch PYTHONDONTWRITEBYTECODE=1 python3 -I tests/tools/local-operational-leases.test.py
```

Disposable artifact roundtrip and ordinary Git sparse fixtures do not prove
production resource admission. If the operational sparse wrapper sees unreadable
current-owner `/proc` activity, its refusal is verified separately from ordinary
fixture Git projection; positive wrapper admission remains unverified in that
environment. Lease, VM, SSH and original guest execution require their actual
owner's native acceptance; pure controls never replace those lanes.

## Historical source preservation verification

`tools/operations/verify-historical-preservation.py` is the maintained read-only
owner for historical remote-source provenance. It checks the complete committed
manifest roster, every owned path and permitted WIP metadata identity, PR
number/source/merge binding, merge ancestry, source-at-merge mode/blob equality,
and the whole original/current diff witnesses. A reviewed-current-owner mapping
still needs independent semantic review. Squash/cherry-pick source history is not
certified as commit ancestry. These checks do not qualify current integration,
CI, runtime, issue acceptance or ref deletion.

The manifest is an explicit historical input, not a generated current authority.
The original source is the fourteen-row data at
`90e2ae9b1d4701815d4ec91baa5948a009ed27c7`, path
`artifacts/change-contract/remote-source-preservation-20261006/historical-preservation.json`.
The physical `--manifest` bytes must equal that whole regular Git blob. Recorded
bindings JSON must explicitly contain `remote` (ref-to-OID map) and `pullRequests`
(PR-number-to-object map with `number`, `state`, `headRefOid`, `mergeCommit.oid`).
They record a historical observation; deleted historical refs need not exist now,
and the verifier never presents these inputs as current remote CAS or grants.

```sh
python3 tools/operations/verify-historical-preservation.py --repository /path/to/source --expected-head CURRENT_EXACT_HEAD --manifest /path/to/whole-historical-preservation.json --manifest-revision 90e2ae9b1d4701815d4ec91baa5948a009ed27c7 --manifest-path artifacts/change-contract/remote-source-preservation-20261006/historical-preservation.json --historical-bindings /path/to/recorded-remote-pr-bindings.json
```

`--live-bindings` explicitly selects read-only `origin`/GitHub observations instead
of recorded bindings. It refuses if the historical audited master or selected refs
have moved/disappeared. Neither mode fetches objects or writes refs. The required
`--expected-head` binds the current local repository separately from the manifest's
historical `auditedMaster`. The explicit manifest revision is a historical object,
even if it is not an ancestor of the local HEAD; it grants no current authority.
HEAD, index bytes and physical identity, local refs and tracked worktree
status/diff must remain identical before and after verification; changed, missing,
unsafe or unreadable inputs refuse. The report always leaves qualification,
current remote-presence certification and deletion authorization false.

Focused source controls run only in the task-owned scratch root:

```sh
FSUSBLOG_OPERATIONS_FIXTURE_ROOT=/path/to/owned/scratch python3 tests/tools/historical-preservation.test.py
```

## Adaptive responsibility scheduling

Inspect `GET /api/ops/cluster/nodes` with an independent admin principal carrying
`system.config`. The `scheduler.unassigned` list means no current healthy,
network-reachable node advertises a required capability. `adaptive-reassigned` is
expected after node failure or a material post-cooldown score improvement;
rapid alternating owners indicates that membership inputs or policy thresholds need
repair.

The admin page `/user/manage/cluster` shows nodes, responsibility state, lease/checkpoint
summary, takeover events and cluster health. The JSON route intentionally omits checkpoint
payloads and network addresses.

For a local incident, call the protected node-state operation with `draining` and wait
for responsibility leases to release or expire; use `maintenance` while the node must
remain excluded, then `alive` after repair. Each mutation requires independent admin
`system.config`, fixed-IP limiting, trusted same-site origin and a one-use
`X-Fsus-Mfa-Proof`. To stop placement without restarting request-serving nodes, call the
scheduler operation with `enabled=false`; the next reconcile deactivates local leased
responsibilities while anonymous, login, admin, notification-stream and binary paths
remain available. Re-enable only after membership and capability coverage recover.

Never clear fencing counters or force another node to bypass a live lease. The expired
lease action is deliberately a no-op while the authoritative expiry is in the future;
Redis TTL may already have removed the lease before the action runs. A mode change back
to `single` is only for the next process generation.

## Module invocation degradation

`module_route_unavailable` means no healthy node currently advertises the required
capability; `module_backpressure` means the bounded remote-call budget is full; and
`module_circuit_open` means repeated remote failures opened the contract circuit.
Drain the unhealthy target or remove its active responsibility and let another healthy
node take the assignment. New requests recover after membership and capability health
return; the circuit probes again after its open interval, so request-serving nodes do
not need a restart. Durable queue consumers may be paused without discarding messages.
Do not bypass the owner contract, redirect writes to another module's tables, or switch
a running multi-node process to the in-memory `single` authority.

## Upload session expiration cleanup

Upload-session cleanup only enumerates the expiration-bucket index; it does not sweep every directory below the session root. If an old orphan is found, quarantine or remove that exact path through an operator-reviewed maintenance action and repair the missing index producer. The cleanup worker may be paused without restarting request-serving nodes, but the unbounded root sweep must not be restored. Production closeout keeps the release-cycle and read-only residual-scan evidence in `tests/backend/runtime-fallback-milestones.json`; absent external observations remain `deferred-unverified`.

## Release Gate

Before publishing a production image:

```bash
./tools/test.sh production-correctness
# Historical compatibility alias for the same browserless authority:
./tools/test.sh production
```

`production-correctness` is the browserless production-ci-gate; historical `production` depends only on that authority and remains a compatibility alias. It runs fast validation, static governance, frontend/backend unit/property/model checks, SSR/AOT/HTTP contracts, API/DB/cache integration, browserless security/resilience/load/backend-QPS checks, frontend render-structure checks, and release evidence schema validation. Its complete dependency closure installs no Playwright browser and starts no Chromium. In particular, it does not run legacy Acceptance, visual, cross-browser, UX viewport, or browser render-pressure suites. A passing production-ci-gate means no compile warnings, no TypeScript/Vite warnings, no browserless runtime console errors or warnings, no API/Binary/WebSocket/AOT contract drift, and no blocker security or workflow regressions in the encoded browserless risk matrix. It may still produce a schema-valid `collected-blocked` release evidence manifest while external production evidence is pending.

`browser-contract` is the only real-browser correctness tier. At the release boundary, and conditionally for `main` / `master` pushes or browser-boundary PRs, it consumes the immutable production build receipt and runs one managed Chromium with one controller/session, no shard, and no retry. `production-summary` and `release-evidence` do not wait for it. Scheduled/manual `browser-diagnostics` separately owns Acceptance, visual, UX viewport, cross-browser, renderer-pressure/performance, and browser-runtime resilience evidence; diagnostics failure remains visible but cannot be rewritten as either a production correctness pass or failure.

`release-closeout-gate` is separate and must run `tools/operations/check-release-evidence-manifest.mjs --require-ok` or `./tools/test.sh release-closeout`. Only `collected-ok` is a release credential.

The same browserless gate is enforced by GitHub Actions `Quality Gate` on pull requests, pushes to `main` / `master`, and manual dispatch. CI requires `GITHUB_PACKAGES_TOKEN` for the private `@ozwasyd` npm package. Ordinary correctness jobs do not install Playwright; the single Browser Contract fixes its worker/concurrency at one, while scheduled/manual diagnostics remain under their separate workflow and matrix policy.

## Coverage Gate

Coverage is enforced as a separate hard gate:

```bash
./tools/test.sh coverage-gate
```

This gate collects backend + frontend coverage, merges reports, and enforces both merged and backend-only thresholds. Frontend collection defaults its local Vitest thresholds to `0` so the artifact step cannot fail on files outside the curated gate denominator; the hard threshold is applied after merge. Current defaults are merged line/branch/method `35%/20%/30%` and backend line/branch/method `75%/55%/95%` for the scoped coverage set (overridable via `FSUSBLOG_COVERAGE_*` env vars).

If VSCode integrated terminal picks an older Node than expected, run:

```bash
bash ./tools/node/check-node24-env.sh 20
bash ./tools/node/fix-vscode-node24.sh 24
```

Then restart VSCode and rerun the gate.

On failure, collect:

- `.tmp/acceptance/*.log` for the shared browserless runtime bootstrap
- `.tmp/browser-contract/receipt.json` for the single correctness browser boundary
- `.tmp/browser-diagnostics/` and `src/frontend/test-results/playwright/` only for scheduled/manual diagnostics
- GitHub Actions `quality-gate-artifacts`

For Docker packaging and slot inspection:

```bash
export GITHUB_PACKAGES_TOKEN=...
./tools/deployment/slot-status.sh
./tools/deployment/slot-preflight.sh \
  --slot green \
  --release-manifest build/releases/<release-id>/release-manifest.json \
  --env-file .env.production
```

`slot-preflight.sh` enforces the fail-closed image runtime contract on the exact
manifest-selected `repository@sha256:<64 lowercase hex>`. It pulls the target digest,
then inspects OCI labels: `io.fsusblog.build.vcpkg-commit` must be a complete 40-character
lowercase Git SHA; `io.fsusblog.runtime.node=required` and
`io.fsusblog.runtime.npm=forbidden`; and `profile-id`, catalog/profile digest, base family,
RID, single-file, R2R, PGO, QuickJIT, Server GC, GC heap-count/hard-limit mode and exact
percentages, ThreadPool, and topology labels must be complete and bound by the same profile
digest. R2R may be enabled by a controlled startup profile and is no longer incorrectly
fixed globally to false. Preflight then runs `command -v node` in a temporary container and
proves that `npm` is absent. A mutable tag, invalid digest, pull/inspect failure, profile
drift, musl/glibc mismatch, missing Node, or present npm terminates before Compose candidate
startup; the persisted active slot stays unchanged and no candidate starts.

Runtime profile qualification seals container-visible CPU/memory identity plus physical-core/SMT and NUMA topology. The executor must echo the observed target cpuset, not only the requested plan. Auto-balanced allocation changes with the named mode: physical-core placement chooses one thread per core; NUMA-local keeps the target in one observed node and the load generator disjoint. Hidden topology is explicitly `unavailable` with a reason, and a single visible NUMA node is `not-applicable`; neither state may be replaced with synthetic topology evidence. The runner classifies only `physical-core-only` or `numa-local` as hardware-unsupported, and only when the sealed topology proves the corresponding capability absent. Evidence v2 records the full required `catalogProfileIds`, the actually scheduled `profileIds`, and a bounded `unsupportedProfiles` reason; their union must exactly cover the catalog before status can become `complete`. Build, gate, measurement, timeout, cleanup, or executor failures remain failed attempts and can never be relabeled as unsupported.

For standalone diagnosis of the same contract, run
`bash tools/deployment/image-runtime-contract.sh '<repository>@sha256:<digest>'`. It
actually pulls/inspects/runs the target image rather than performing an offline Dockerfile
check. After failure, rebuild and push a corrected new digest, then generate a new manifest;
do not overwrite with a tag or skip preflight.

### Runtime/publish profile qualification

Before running, validate the catalog with `check-runtime-publish-profiles.mjs`. Qualification
tests must use the same commit, data fixture, target host, cgroup/cpuset, proxy/TLS,
PostgreSQL, and Redis configuration; isolate load-generator and target CPUs. Do not combine
cross-machine results into three rounds or treat the acceptance environment's burst-derived
ThreadPool minimum as the production default.

After interruption, matrix evidence may retain a `partial` checkpoint; resume with
`--resume-from <evidence>` against the same parameter set. Resume verifies commit, fixture,
hardware, profile manifest, catalog, unsupported-hardware list, profile order, round count,
cooldown, and complete schedule; it skips only successful schedule keys and appends a new
attempt for missing or failed keys. Never resume old evidence after hardware capability
changes; rerun under the new hardware identity. `runs` is the non-reducible complete attempt
history: failures must precede the final success for the same key; a complete artifact
requires exactly one final success per schedule key, and comparison summarizes only those
successful samples. Only a three-round artifact passing `check-runtime-publish-evidence.mjs`
without `--allow-partial` may enter selection. Full runs must receive the site policy and
retain `auto-balanced`: the executor dynamically allocates target/loadgen from the current
process-visible cpuset/quota/memory and topology, then passes resolved CPU count, GC
modes/percent, ThreadPool mode, and topology mode to the repository stage adapter. The
adapter invokes the site plan's direct executable and requires each stage to return a
structured result with the same identity; build, gate, NativeAOT parity, fault/load fixture,
and measurement payload are all bound to the digest receipt. Measurement must reread actual
cpuset/cgroup/runtime settings and report in `resourceStress` allocation burst, GC pressure,
OOM/recovery where applicable, and a blue/green memory breakdown whose active/candidate/
snapshot/SSR/other values sum exactly. The default complete matrix covers every required
profile without `conditionalAdmission` that the current hardware can execute;
`physical-core-only` / `numa-local` enter `unsupportedProfiles` only when sealed hardware
explicitly lacks support. NativeAOT still runs as a separate partial experiment and requires
feature/security parity. Failed profiles must retain their errors. Selection records must
cite startup and steady-state conclusions, per-route median/CV, pairwise/Pareto,
variance/materiality, JIT/GC/LOH/ThreadPool/migration/IPC, power, resource stress, and
fault/recovery; a startup-only profile cannot replace the throughput default. When collecting
release evidence, the matrix's full commit SHA, sealed selected profile, and two non-zero
digests must match release identity. The collector copies and computes the `runtimePublishMatrix`
sha256; the manifest checker and release-final reread ordinary non-symlink files in the bundle,
and fail closed on any missing file, path escape, digest drift, wrong SHA, wrong/zero profile
digest, or unselected state.

Always roll back by selecting an old profile's immutable digest still retained in the registry
and generating a new monotonic generation through the normal rollout. Do not modify existing
image labels, manifests, or mutable tags. If only the evidence-derived ThreadPool minimum is
being revoked, restore `runtime-default` deployment settings and restart the corresponding
retained image; confirm ThreadPool queue/starvation, context switches, RSS, and p99.9 recover
before continuing rollout.

## Rollout

<a id="唯一入口与资源前提"></a>
### Single entrypoint and resource prerequisites

Production releases, explicit rollbacks and interrupted resumes all enter through
`tools/deployment/release-rollout.sh`. Except for the one-time empty-state bootstrap
and diagnosis, do not call `slot-start.sh`, `gateway-switch.sh` or
`deploy-production.sh` directly. First run `slot-status.sh` and require durable state
`stable` with `activeStateConsistent=true`, then select an immutable manifest produced
by CI and still retained by the registry.

The zero-downtime floor is defined by
`config/deployment/zero-downtime-resource-policy.json`: 4 CPU cores, 6144 MiB total
memory and 10240 MiB free disk. The two slots together are budgeted for 360% CPU and
4608 MiB memory, with 8192 MiB temporary disk and at least 10 overlap samples. A
2C/2G host may run one slot only; it cannot perform overlap or claim zero downtime.
The lower pull/start guard in `slot-preflight.sh` does not replace this qualification
gate.

Store exactly one `Authorization: Bearer ...` or `Cookie: ...` header in a
root-readable mode-0400/0600 regular non-symlink file. Authentication storage state
must also be mode 0400/0600. Do not put secrets in the command line, evidence, issue
comments or shell trace.

The complete base invocation, including its environment exports and runtime-input
flags, is maintained once in [Production Deployment — Build And Deploy](production.md#build-and-deploy).
Use that canonical block unchanged:

```bash
export FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE=/run/fsus/deployment-admin-header
export FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN=https://fsus.blog
export FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL=https://fsus.blog/health/ready

./tools/deployment/release-rollout.sh \
  --rollout-id deploy-<release-id>-<unique-suffix> \
  --release-manifest build/releases/<release-id>/release-manifest.json \
  --env-file .env.production \
  --slot-state-file /var/lib/fsusblog/deployment/slots.json \
  --rollout-state-file /var/lib/fsusblog/deployment/rollouts/<rollout-id>/state.json \
  --evidence-root /var/lib/fsusblog/deployment/rollouts \
  --backup-restore-evidence .tmp/operations/backup-restore-drill.json \
  --migration-server-dll /app/FsusBlog.Server.dll \
  --production-build-receipt .tmp/ci-production-build/receipt.json \
  --traffic-scenario /run/fsus/release-traffic-scenario.json \
  --notification-auth-storage-state /run/fsus/notification-auth-state.json \
  --asset-compatibility-scenario /run/fsus/asset-compatibility-scenario.json \
  --worker-ledger /run/fsus/worker-normal-ledger.json \
  --fault-injection-evidence /run/fsus/fault-matrix.json \
  --public-url "$FSUSBLOG_GATEWAY_PUBLIC_PROBE_URL" \
  --admin-header-file "$FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE" \
  --control-origin "$FSUSBLOG_DEPLOYMENT_CONTROL_ORIGIN" \
  --asset-store /var/lib/fsusblog/release-assets \
  --dry-run
```

Run it first with `--dry-run` and review the exact source/target release, digest, slot,
generation, state path, and ordered stages; then rerun without `--dry-run` using the same
new `rolloutId` and identical inputs. Existing state must use `--resume`; it must never be
overwritten.

<a id="15-阶段与断点恢复"></a>
### 15 stages and interruption recovery

The complete order is fixed:

`manifest-validate -> capacity-preflight -> backup-restore-gate -> expand-migration -> asset-materialize -> candidate-start -> candidate-readiness -> candidate-smoke -> compatibility-smoke -> gateway-switch -> source-drain -> active-fence -> public-verify -> source-stop -> release-evidence`

Each attempt writes command stdout/stderr, start/end times, exit code, SHA-256, and bytes to
mode-0600 stage evidence. A successful stage cannot be repeated; a failed stage first enters
`recovery_required` and runs stage-specific compensation. Security-critical gates have no
skip parameter.

After the host process receives SIGTERM/SIGKILL or exits abnormally, read state first; do not
start over:

```bash
node tools/deployment/rollout-state.mjs read \
  --state /var/lib/fsusblog/deployment/rollouts/<rollout-id>/state.json

./tools/deployment/release-rollout.sh \
  --resume \
  --rollout-id <same-rollout-id> \
  --rollout-state-file /var/lib/fsusblog/deployment/rollouts/<rollout-id>/state.json \
  --release-manifest build/releases/<release-id>/release-manifest.json \
  <the-same-runtime-input-options>
```

Resume verifies that the manifest matches the durable target and uses probes that are still
alive and match the command-line/path anchor. It seals orphan running stages without terminal
evidence as interruption failures, then performs that stage's explicit recovery. It skips only
stages with sealed success evidence. Terminal state, another rollout ID, another release/digest,
or a historical passing artifact cannot be reused.

<a id="切流-fence-排空与存储"></a>
### Traffic switch, fencing, drain, and storage

The Gateway stage uses `--defer-source-drain`: CAS-activate the target, atomically reload, and
commit traffic state while keeping the source recoverable. The active-fence stage then uses
release/slot/generation/digest for Redis CAS, revokes the source, and reads back the target
owner. After acquiring a lease, every active-singleton worker must also run
`IActiveReleaseCommitGuard.EnsureCurrentAsync` before an irreversible commit; an old generation,
even if still running, cannot commit a scheduled transition, outbox effect, crawler snapshot,
cleanup delete, projection checkpoint, PublicAOT finalize, or upload deletion.

Public verification concurrently runs sustained 12-class traffic, notification reconnect/replay,
N/N-1 asset/Service Worker, and resource-budget probes. Source drain first sends 1012 restart,
then drains HTTP, notification, background claims, article-view, hot-stats, audit/admin-audit,
visit, RUM, security/challenge audit, public-hot, ArticleDetail AEDS, PublicAOT backfill, and
upload cleanup in parallel. Any pending, timeout, or error remains in blockers; success cannot
be handwritten.

Before candidate start, `asset-materialize` validates the sealed CI receipt's complete schema,
source/worktree, producer/toolchain, input, domain, path/size/SHA-256, and seal. Before the
first store write it requires the image-extracted source and receipt frontend domain to be
exactly the same set, then writes manifest-selected frontend/Wasm/font files to append-only
`<asset-store>/releases/<releaseId>`; different hashes at the same path fail closed. It
generates an inventory and requires the receipt frontend artifacts, inventory, and actual
materialization to be exactly the same set, then installs read-only
`spa-manifest-descriptor.json` and `production-build-receipt.json`. Compose and `slot-start.sh`
accept only these two canonical authority paths under the current release.
`UseReleaseScopedStaticAssets` serves `/release-assets/<releaseId>/...` and
`/release-derived/<releaseId>/...` before SPA fallback; Production refuses to start when the
root setting is missing. Applied GC must persist retention state first, protect the N-1
`retention-window`, then have the old-asset probe reread every old URL after GC. Release-derived
writers write only their own release subtree and atomically update the pointer through the
generation publisher; they must not clear the shared root or another release.

Do not manually split this runtime wiring: manifest validation generates `FSUSBLOG_RELEASE_ID`;
the host-side manifest path exists only in `FSUSBLOG_RELEASE_MANIFEST_HOST_PATH` for Compose's
read-only mount; the container always reads `FSUSBLOG_RELEASE_MANIFEST_PATH=/app/release-manifest.json`
and accesses the shared derived volume through `FSUSBLOG_RELEASE_DERIVED_ROOT=/app/release-derived`.
All three must point to the same release identity. Do not hard-code them in `.env.production` or
let the container read another manifest or derived root.

The comment mutation outbox exposes backlog, failed, poison, oldest age, cumulative processed,
and recent errors at `/api/ops/health/ready-detail` under
`runtime.commentMutationOutbox`; `fsus.comment_outbox.*` metrics cover throughput, failures,
backlog, oldest delay, and dead letters. Non-zero poison marks runtime readiness degraded.
Operations may set reloadable `CommentMutationOutbox:Enabled=false` to pause new claims (the
comment authoritative transaction continues writing pending without losing events); restore
`true` after fixing the dependency or poison root cause. Do not delete checkpoints or manually
mark unknown side effects completed. Full steps: [`architecture/comment-mutation-outbox.md`](architecture/comment-mutation-outbox.md).

<a id="强流量-资产-hmac-与-migration-qualification"></a>
### Strong traffic, asset HMAC, and migration qualification

The single rollout entrypoint must obtain two independent private-key files:

In addition to manifest, migration, notification, worker, resource, and fault arguments, the
complete `release-rollout.sh` invocation must include these four (parameter fragments only,
not a second executable entrypoint):

```text
--traffic-scenario /run/fsus/release-traffic-scenario.json
--traffic-binding-key-file /run/fsus/secrets/traffic-binding.key
--asset-compatibility-scenario /run/fsus/release-asset-browser-scenario.json
--asset-browser-binding-key-file /run/fsus/secrets/asset-browser-binding.key
```

Both keys must be 0400/0600 regular non-symlinks, 32..4096 bytes, and must not be reused
with the admin header, Cookie/storage-state, or each other. Dedicated verifiers perform HMAC
readback for the traffic and asset/browser artifacts respectively; `--resume` must not skip
verification because a file already exists. A key error or evidence drift blocks closeout but
does not require an application restart: keep the source before the switch, restore the source
gateway/fence through durable recovery after the switch, and use a new monotonic generation.

The private rehearsal plan requires these fields:

| Area | Field | Constraint |
| --- | --- | --- |
| traffic | `evidenceInputs.trafficBindingKey` | private key file, 32..4096 bytes |
| asset | `evidenceInputs.assetBrowserBindingKey` | independent private key file, 32..4096 bytes |
| migration binary | `target.migrationServerDll` | exact Server DLL for the target manifest |
| migration scenario | `migrationQualification.scenarioTemplate` | fixed ten-scenario template |
| migration timeout | `migrationQualification.timeoutSeconds` | 60..1800 |
| migration IDs | `expandMigrationId` / `backfillMigrationId` / `contractMigrationId` | safe immutable IDs |

The rehearsal automates and executes ten scenarios: old Active + Expand, dual-slot concurrent
read/write, Backfill pause/checkpoint/resume, missing Expand 503, rollback-window Contract
rejection, post-Contract non-rollback marker, advisory-lock timeout, database disconnect,
partial failure/resume, and history checksum + unknown record. The repository adapter accepts
only `ASPNETCORE_ENVIRONMENT=Test` + `FSUSBLOG_ROLLOUT_REHEARSAL=1`; the application
bridge/readiness route additionally requires `SchemaMigration:QualificationEnabled=true`,
admin `system.config`, and `fixed_ip`. Production configuration remains false.

<a id="normal-与-destructive-qualification"></a>
### Normal and destructive qualification

Normal production rollout accepts only worker reconciliation v2 `mode=normal`: eight durable-work
classes, graceful drain, target exactly-once, and zero stale-generation commits. Forced-source/
SIGKILL is an independent Test-topology qualification and must not be embedded in normal source
drain:

After dry-run review, start the normal observer alongside the real rollout. It waits for durable
state to reach `candidate-start`, drives/observes eight real pending classes through loopback
admin actions, and exclusively writes the ledger passed to rollout as `--worker-ledger` after
`source-drain-gate.json` passes. The plan's `baseUrl` must be the exact loopback origin; the
admin header is still read only from a 0400/0600 regular non-symlink file:

```bash
node tools/deployment/release-worker-normal-observer.mjs \
  --plan /run/fsus/release-worker-normal-observer-plan.json \
  --rollout-state /var/lib/fsusblog/deployment/rollouts/<rollout-id>/state.json \
  --source-drain /var/lib/fsusblog/deployment/rollouts/<rollout-id>/evidence/source-drain-gate.json \
  --admin-header-file "$FSUSBLOG_DEPLOYMENT_ADMIN_HEADER_FILE" \
  --out /run/fsus/worker-normal-ledger.json \
  --run-id normal-<rollout-id> \
  --start-stage candidate-start \
  --timeout-ms 900000
```

Observer start/status/finalize responses must bind rollout ID, source/target release/digest/slot/
generation, explicitly set `destructive=false`, and preserve exactly ordered events in eight
classes. A ninth forced-source event, static pass JSON, qualification ledger, final observation
before drain, or truncated error list fails.

Do not conflate `release-worker-normal-observer.mjs` with
`release-worker-observer-service.mjs`. The former is the normal-rollout sidecar observer; the
latter is started temporarily only by `zero-downtime-rehearsal.sh` in an isolated `Test`
topology for deploy/rollback/resume, qualification, fault, and SIGKILL/resume stages. The
rehearsal copies private `workers.observerEnvFile` to a mode-0600 service root, listens on
loopback in an independent process group, and stops the service on success, failure,
interruption recovery, and teardown; premature exit or inability to stop it fails the rehearsal.
Production must not set `ASPNETCORE_ENVIRONMENT=Test`, `FSUSBLOG_ROLLOUT_REHEARSAL=1`,
`FSUSBLOG_WORKER_OBSERVER_ENABLED=1`, or any `FSUSBLOG_WORKER_OBSERVER_*`, nor register this
service as a resident daemon.

```bash
tools/deployment/zero-downtime-rehearsal.sh \
  --plan /run/fsus/zero-downtime-rehearsal-plan.json \
  --mode all
```

Qualification uses nine ledger classes and a file handshake, then tears down. Afterwards, create
a fresh normal rollout with a different rollout ID and the same target release/digest.
Qualification v2 hash-binds qualification control, ledger, resource policy, reconciliation, and
distinct normal state. Never force-kill the production source container, treat a qualification
ledger as a normal ledger, or reuse historical state/evidence.

<a id="evidence-bundle-与-closeout"></a>
### Evidence bundle and closeout

Final evidence allows only six artifact classes: `publicTraffic`, `notificationStream`,
`assetCompatibility`, `workerReconciliation`, `resourceBudget`, and `faultInjection`. It must
seal 15 stages, all attempts and recoveries, then perform read-back verification. Set:

```bash
export FSUSBLOG_RELEASE_ROLLOUT_EVIDENCE=/var/lib/fsusblog/deployment/rollouts/<rollout-id>/evidence/release-rollout.json
tools/operations/collect-release-evidence.sh
```

The collector uses `collect-release-rollout-bundle.mjs` to copy only final evidence, 15-stage
command evidence, sealed recoveries, and the six hash-bound artifacts, producing
`release-rollout-bundle/bundle-index.json`. For a separate export, run:

```bash
node tools/operations/collect-release-rollout-bundle.mjs \
  --input "$FSUSBLOG_RELEASE_ROLLOUT_EVIDENCE" \
  --output /run/fsus/handoff/release-rollout-bundle
```

The target directory must not exist; symlinks, path escapes, post-seal drift, unreferenced files,
or a seventh artifact class all fail. The release manifest's
`evidenceSummary.operations.releaseRollout` and bundle semantic check must be `ok`, but this
does not replace real DNS/firewall/live exposure or `--require-ok` closeout.

<a id="风险-无需重启回退与场景覆盖"></a>
### Risks, no-restart rollback, and scenario coverage

- Failure before traffic switch: keep the source Active and stop the candidate; fix inputs and
  resume with the same state, or use a new rollout after an explicit terminal outcome.
- Switch activated but not committed or post-switch gates not passed: restore source include,
  restart/activate source with a new monotonic generation, and CAS-drain target; retain
  `rollback_required` when neither can be proven.
- Traffic committed but source drain failed: keep target Active, block closeout, and handle the
  old inactive source; do not automatically switch back.
- Expand/Backfill: retain the N/N-1 bridge; Backfill pauses only the durable token and needs no
  restart. Stop the command before Contract; after destructive Contract, isolate the write path
  and restore the verified backup, because image rollback cannot recreate data.
- Asset/derived failure: stop applied GC, continue protecting N-1, and rebuild the current
  release generation; do not restore mutable `current` paths or delete the active/previous release.

Traffic scenario and release acceptance must cover anonymous home/archive/article/search/static/
Binary; login, refresh, protected read and write; admin health/control; notification-stream
1012 reconnect, cursor replay, replay-miss full resync, slow-client drain; uploads; and AEDS
Binary frames. Deployment 502/503/504, unclassified 5xx, connection failures, timeouts, and
aborted in-flight requests are release errors; only business 5xx with explicit
`X-Fsus-Error-Class: business` and an error code in the scenario allowlist may be separately
classified.

## Comment Length Policy

Comment length is centrally controlled by the backend's “anonymous comment policy”, defaulting
to `1000` characters / UTF-8 `4096` bytes. An administrator may raise the limit at
`/user/manage/moderation/anonymous-policy` to at most `3000` characters / UTF-8 `12288` bytes;
submission requires an admin-sensitive step-up, and the server writes high-value audit data
and triggers the existing anonymous comment policy cache invalidation.

Rollback needs no restart: after restoring the policy to `1000/4096`, new public-attributed and
strictly anonymous comments are validated against it immediately; published comments are not
string-truncated, and the display layer still collapses long comments by rendered height by
default. Regardless of policy changes, the comment-Markdown security boundary still disables
images, raw HTML, dangerous links, LaTeX, and Mermaid, and frame creation remains protected by
the 16 KiB payload limit.

## Rights V3 Public Artifact Cutover

ArticleDetail AEDS embeds the Rights V3 snapshot and proof summary in the detail payload. Current writers emit `ARD4`/version 4 and the file store accepts both current V4 and read-compatible `ARD3`/version 3 artifacts; retired pre-envelope ArticleDetail files remain invalid compatibility inputs.

Use the full deployment runbook in [rights-v3-cutover-runbook.md](rights-v3-cutover-runbook.md) for backups, the exact no-compat order, verification, and operator checks. This section is only the short operational summary.

Use the admin cache action endpoint for the remaining cutover sequence:

1. Before candidate start, require the rollout's read-only compatibility check to prove the Rights V3 schema and legacy-artifact cleanup descriptors are already present in migration history. The automatic `expand-migration` stage runs only currently classified online Expand work; it does not replay the legacy Rights V3/cleanup descriptors. A pre-protocol database missing them must first complete the isolated legacy bootstrap/restore runbook and then enter the online protocol.
2. Run `recompute-article-rights` to replace migration sentinel hashes and create any missing latest-revision rights snapshot.
3. Run `rebuild-article-detail-aeds-v3` with no `articleId` to rebuild all public ArticleDetail artifacts in batches with bounded parallelism. Supplying `articleId` rebuilds one article.
4. Run the existing PublicAOT rebuild path after ArticleDetail artifacts have been rebuilt by the historically named action into current V4 output (with V3 read compatibility), so HTML/hydration inputs converge on the same rights payload.

Rollback is image and database-backup based. Do not roll back by re-enabling retired pre-envelope ArticleDetail reads or by adding a separate `/article/{id}/rights.aeds` endpoint; a partial rollback would let anonymous reads serve a payload shape that current V4/V3 decoders must reject.

## Queue-owner diagnostic projection

The protected `/api/ops/health/ready-detail` probe keeps readiness and qualification
under `BoundedQueueDrainAggregator`. `runtime.requiredQueues` and
`runtime.boundedQueueDrain` retain the same aggregate run, content digest, status,
qualification and blockers. `requiredQueues.queues` describes catalog participant
obligations; `commitPostcondition` is the participant's commit fact, not its last
delivery disposition.

`runtime.requiredQueues.ownerDiagnostics` preserves the original snapshots from
`audit-log`, `admin-audit-log`, `security-risk-event` and `challenge-v2-event`.
Each available owner reports its actual cumulative `committed`, `durableAccepted`
and `requeued` counters, `sequence`, and controlled `lastDisposition`.
`evidenceKind=OwnerSnapshot` and `qualificationEligible=false` are fixed: these
independently sampled diagnostics cannot authorize readiness, drain or release.
An absent owner is omitted as unavailable, not represented by zero. The challenge
owner appears once; its shared cumulative counters must not be copied to or added
across the high-value and normal participant lanes. These values remain owned by
the original channel/journal snapshots, without a new accounting service or cache.

The former participant-level `committed`, `durableAccepted`, `requeued` and
`lastDisposition` fields are retired as nullable `null`; consumers must read the
owner diagnostic map instead of treating the previous constant zeros or commit
postcondition as delivery observations. Unknown disposition text is projected as
the fixed `unknown` category. Raw `lastItemReference` is deliberately `null` in
both this map and the existing `runtime.auditLog` health projection. Retained
references can contain event text, exception messages or private identifiers;
`AuditRead` does not grant investigation access. `QueueId` is not an item identity.
The new `ownerDiagnostics` map exports no item reference, arbitrary owner failure
text, pseudonym, or new telemetry label. The existing `runtime.auditLog` projection
only redacts `lastItemReference`; its other error fields are unchanged and are not
certified by this change. Internal delivery identity, payload, replay and retention
accounting remain under their existing owners. Unavailable owner snapshots or
service resolution are omitted independently, after the aggregate observation;
they cannot suppress its structured failure receipt or supply zero counters.

This is the existing registered operations-tool health JSON boundary in the
[AEDS-only policy](api/aeds-only-policy.md), not an application API or a new AEDS
payload. The protected probe permission and minimal public `/health/ready`
projection remain unchanged. The separate AEDS `OpsHealthResponse`, frame 106,
Shared/Core/POD/C++/TypeScript wire surfaces do not carry this diagnostic map.
This health-projection boundary does not certify the privacy of other deployment
drain reports, investigation paths or historical logs.

## Daily Checks

- `docker ps` health status is healthy.
- `/health/ready` returns public minimal readiness JSON with `status=ready` and `checkedAt`. The public probe is served from a 5 second single-flight readiness snapshot so high-frequency orchestrator checks do not run PostgreSQL, Redis and RiskControl deep probes on every request; use `/api/ops/health/ready-detail?forceRefresh=true` when an operator needs an immediate deep refresh.
- `/api/ops/health/ready-detail` `checks.release` must equal the selected release manifest for `releaseId`, `releaseSlot`, full `commitSha`, `imageRef` and `imageDigest`. Any `release_identity_invalid` result blocks traffic; correct the manifest/environment binding or redeploy a retained digest, without changing a mutable tag in place.
- `/api/ops/health/ready-detail` runtime startup snapshot shows expected `schemaMigration` / `accountSubjectHashInvariant` / `searchIndex` / `cacheInitializer` / `aotDiskCache` / `bootstrapRollback` task states for the current rollout. The snapshot is sourced from `StartupRuntimeState.CreateSnapshot()` and is independent from PublicAOT/AEDS payloads. The production schema runner is current-receipt admission, not a historical compatibility evaluator. The current schema health check must reverify the explicit receipt, candidate and live database binding; a startup task label or an untrusted `ready` report cannot substitute for that observation. `accountSubjectHashInvariant` must report `physical_projection_complete` before candidate traffic is enabled; `cacheInitializer` reports either `no_entries` or the number of rollback entries it can restore. The same runtime block exposes `scheduledPublish` with `lastPublishedCount`, `lastFailedCount`, `dueBacklog` and `lastError`; non-zero failures mean due scheduled articles remain queued for the next worker tick and should be investigated before release closeout.
- `/api/ops/health/ready-detail` includes `observability` with service name/version, ActivitySource, Meter and whether OTLP export is enabled.
- `/api/ops/health/ready-detail` includes `riskControl` with active policy, last-known-good policy, Redis consume-once and challenge provider registry state. If this check fails, keep the candidate out of traffic; write-class challenge paths fail closed, while public-read degradation must follow the active policy rather than bypassing RiskControl.
- `/api/ops/health/ready-detail` includes `deployment` with release/slot/mode/state/generation, `canReceiveTraffic`, `canClaimBackgroundWork` and the drain snapshot. Any Candidate not exactly Ready, any Draining/Stopped/Failed state, or a generation mismatch blocks switch/closeout.
- Disk usage for Docker volumes and container logs is below alert thresholds.
- PostgreSQL connection usage leaves headroom for migrations and backups.
- Redis memory and eviction policy are within expected bounds.
- WebSocket binary notification stream connection count matches expected traffic and does not grow without release.

## Observability

OpenTelemetry is enabled in-process by default and uses `FsusBlog.Server` as the custom `ActivitySource` / `Meter`. ASP.NET Core, outgoing HTTP, runtime, Npgsql, WebSocket notification metrics, cache operations, PublicAOT render source, search rebuild/query and scheduled-publish worker timings are recorded with bounded `fsus.*` tags only.

The separately registered `FsusBlog.HttpTransport` meter adds `fsus.http.transport.request.count` with bounded `fsus.http.protocol` and `fsus.http.route_class` tags, plus one `fsus.http3.startup.count` sample with startup status and prerequisite fallback reason. H3 attempts and handshake failures that never produce an HTTP request are client-side signals; collect them with the local probe instead of inventing server request metrics. The probe also records H2/H3 p50/p95/p99, throughput, errors and process CPU/RSS. See `docs/testing/http3-local-equivalent-experiment.md`.

DI graph health is part of the same telemetry boundary. `/api/binary/author/ops/health` exposes the admin-only `dependency-graph` row, while `fsus.di.graph.registration_count`, `fsus.di.graph.captive_dependency_count` and `fsus.di.graph.opaque_factory_count` expose graph size and validation coverage. A non-zero captive count prevents a new candidate from building; do not bypass it. `di.scope` activities prove the begin/end boundary for instrumented hosted-service DbContext scopes. The safe rollback is to leave the current active slot serving traffic, fix the offending registration or scope ownership, and rebuild the candidate; changing a scoped service to singleton or disabling `ValidateScopes` is not an accepted recovery.

OTLP export is off by default. Enable it by setting either `Observability:ExporterEnabled=true` with `Observability:OtlpEndpoint=http://collector:4317`, or the standard `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable. Requests return `X-Fsus-Trace-Id`, and Serilog/audit request context uses the same trace identifier for log correlation. Do not add raw route parameters, request/response bodies, cookies, tokens, IP addresses, usernames or email addresses as OpenTelemetry attributes.

L0 PublicHotRead and L1 cache capacity hit-rate share one formula:
`calibrated-hits / (calibrated-hits + exact-misses)`. Sampled L0 hit counters
are published as weighted counts; miss/error counters stay full-fidelity. Do
not divide raw hit samples by exact misses, and do not treat `CounterMode=Off`
as a 0% hit rate. Operator reading is in
[PublicHotRead hit-rate accounting](operations/public-hot-read-hit-rate.md).
List/category/tag Serving misses use `503` + `Retry-After: 1` for not-resident
or rebuild-pending, `404` without `Retry-After` for authoritative not-found,
and `200` when last-good or fresh L0 still has the artifact. Operator reading
is in
[PublicHotRead serving miss outcomes](operations/public-hot-read-serving-outcomes.md).
Local miss-path wait (singleflight acquire + lease wait + rebuild) has a
documented total budget; followers with qualified last-good serve stale instead
of waiting for the rebuild. See
[PublicHotRead miss-path wait budget](operations/public-hot-read-miss-path-budget.md).

## SLO Alerts

Production SLO definitions are machine-readable in `config/observability/slo.yml`; `tools/operations/check-slo-definition.mjs` verifies availability, error-rate, p95/p99 latency, WebSocket reconnect success, AOT hit rate, search rebuild success and scheduled publish delay objectives before the release gate proceeds.

The release SLO fixture is executable:

```bash
tools/operations/check-slo-alert-fixture.mjs
```

It writes `.tmp/operations/slo-alert-fixture.json`. With no argument it uses an embedded synthetic incident and asserts that every required alert can fire. A production or CI fixture can be passed as the first argument; it should include `/api/ops/health/ready-detail` JSON, `notificationStream.slowDisconnectsLast5m`, security status report data, `security.authRefreshFamilyRevokeWindowsLast5m` from the bounded refresh-replay metric window, `security.authRefreshCookieWriteFailedLastMinute`, and optional thresholds such as `authRefreshCookieWriteFailedLastMinute`.

| Alert | Impact | Investigation entry | Rollback or degradation action |
| ------- | -------- | --------------------- | -------------------------------- |
| `ready_degraded` | Candidate traffic switch and release closeout are blocked. | `/health/ready` status, `/api/ops/health/ready-detail`, runtime startup tasks, scheduled publish snapshot, app logs. | Keep traffic away from the candidate image or switch back to the previous image tag. |
| `db_latency_high` | Cache misses, authoring writes, reads and migrations can stall behind PostgreSQL pressure. | `/api/ops/health/ready-detail` `checks.postgres.latencyMs`, DB concurrency gate snapshot, slow SQL logs, PostgreSQL connection usage. | Reduce public traffic, pause non-essential writes/background work, then rollback if latency started with the deploy. |
| `redis_latency_high` | L2 cache, WebSocket notification backlog replay and cache-control fanout can become slow or stale. | `/api/ops/health/ready-detail` `checks.redis.latencyMs`, Redis memory/eviction policy, network path and command latency. | Keep the app out of new traffic until Redis recovers; allow public fallback only after readiness is healthy. |
| `risk_control_not_ready` | Challenge enforcement can no longer prove active/LKG policy, provider registry or Redis one-time consumption. | `/api/ops/health/ready-detail` `checks.riskControl`, structured `security challenge * failed` logs, `fsus.security.*` metrics. | Keep traffic away from the candidate, restore policy snapshots/provider registration/Redis, and only re-enable write-class challenge paths after readiness is healthy. |
| `aot_backfill_failed` | Public pages may fall back from server AOT shells to SPA rendering and lose first-load performance. | `runtime.startup.tasks.aotDiskCache`, PublicAOT worker logs, AOT cache directory permissions, `aotBackfill.failuresLastHour` if exported by the collector. | Disable one-shot AOT cache cleanup, keep SPA fallback enabled, and rerun backfill after fixing renderer or filesystem failures. |
| `search_rebuild_failed` | Search results and distribution version coherence can be stale after article mutations or deployment. | `runtime.startup.tasks.searchIndex`, `search.rebuildFailuresLastHour`, search artifact directory and `SearchIndexService` logs. | Restore previous search artifacts or previous image, keep public reads online, and rebuild the index before closeout. |
| `notification_stream_disconnect_spike` | Notification streams can miss live updates and increase replay pressure for authenticated/admin clients. | `fsus.notification_stream.slow_disconnects`, `/api/ops/health/ready-detail` `runtime.notificationStreamConnections`, gateway websocket buffering and slow consumer logs. | Lower gateway traffic or reconnect pressure, preserve polling/fetch fallbacks, and revert gateway changes that introduced buffering. |
| `cache_registry_missing_scan` | Cache prefix invalidation has fallen back to Redis keyspace scan because registry membership is missing or stale. | `fsus.cache.operation.count` with `registry_missing_scan_recovered` / `registry_missing_scan_empty` / `registry_missing_scan_failed`, Redis `cache:registry:*` sets, `RemoveByPrefixAsync` warnings, cache governance catalog. | Treat repeated fallback as degraded cache-control behavior; rebuild registry through normal writes or clear the affected family during low traffic. Failed scans require Redis connectivity and ACL investigation before promotion. |
| `auth_refresh_family_revoke` | A stale refresh token reached an active ordinary-session family and the atomic replay guard revoked it. Any value above zero in the five-minute window is security-significant. | `fsus.auth.refresh.family_revoke_window_count`, `fsus.auth.refresh.family_revoke_count`, bounded auth audit categories and deployment/client retry timing. Never export refresh token, session id or device fingerprint values. | Do not disable family revoke. Block closeout, clear ordinary user sessions if replay is systemic, and keep independent admin principals, public reads and notification reconnect available during investigation. |
| `auth_refresh_cookie_write_failed` | More than the configured number of refresh rotations in one minute could not verify or stage their Cookie response. | `fsus.auth.refresh.cookie_write_failed_count`, process restarts, response aborts, PostgreSQL connectivity and the client single-retry outcome. Never export token, Cookie or session values. | Block promotion and drain the unhealthy instance through the gateway without restarting healthy instances. Keep family revoke enabled; ordinary clients may re-authenticate while public reads, independent admin access and notification reconnect remain available. |
| `public_hot_read_sensitive_bypass` | A sensitive API namespace reached the PublicHotRead early classifier boundary; the request still bypassed L0 and continued through the normal authentication/authorization pipeline. | `fsus.hotread.classifier.sensitive_bypass`, `public-hot-read-sensitive-prefix-bypass` warnings, production gateway sensitive-prefix locations. | Hot-reload `PublicHotRead:Enabled=false`, keep the normal endpoint pipeline online, inspect gateway/request routing, and re-enable only after the counter remains zero. |
| `public_hot_read_retiring_pressure` | A reader keeps one or more retired immutable snapshots alive, so a new publication exceeded the bytes budget or an explicitly configured count/deadline guard. | `fsus.public_hot.retiring.bytes`, `fsus.public_hot.retiring.evictions`, PublicHotRead lifecycle history and current snapshot version. | Pause snapshot rebuild/publication and let readers drain; if pressure persists, hot-reload `PublicHotRead:Enabled=false` so anonymous and binary reads use the normal cache/endpoint path. Do not delete live-reader tracking or restart healthy instances merely to hide the pressure. |
| `public_hot_read_sanity_fallback` | The active snapshot exceeded `MaxSnapshotAge`, a selected binary/HTML artifact failed its process-local HMAC, or a DB transition is still protected by a revocation fence, so L0 stopped serving untrusted bytes. | `fsus.hotread.sanity.fallback`, `public-hot-read-snapshot-update-failed` / `public-hot-read-snapshot-warmup-failed`, `public-mutation-fence-recovery-cycle-failed`, `public-mutation-fence-recovery-enqueue-failed`, active `TransitionPending` tombstones, advisory-lock owner state and update queue depth. | Keep the canonical endpoint path online for sanity fallbacks; active tombstones intentionally remain 410. Inspect DB/outbox/revocation convergence and let the scope-bound advisory-lock recovery prove the writer ended before rebuilding. Hot-reload `PublicHotRead:Enabled=false` if ordinary fallbacks persist, but never delete a tombstone, disable revocation, or raise `MaxSnapshotAge` merely to hide stale data. |
| `public_hot_delivery_obligation_failed` | A PublicHot rebuild exhausted bounded retry or reached a terminal failure, so readiness and release qualification are blocked while the last verified snapshot remains available. | `/api/ops/health/ready-detail` `publicHotRecovery`, the retained Redis obligation record and its bounded attempt evidence, target/published generations, failure kind and next eligibility. | Restore the failed dependency, then invoke the protected `public-hot-rebuild` action or restart the affected instance to replay the retained obligation. Do not delete or rewrite the obligation, mark a recovered attempt clean, or enable unbounded retry; hot-reload `PublicHotRead:Enabled=false` only when the canonical endpoint path is the intended no-restart degradation. |
| `public_aot_memory_cache_eviction` | The bounded Public AOT memory tier reached its dynamic or configured count/bytes/deadline; repeated evictions can increase file reads but do not remove disk artifacts. | `fsus.public_aot.memory_cache.evictions` by `fsus.reason`, `fsus.public_aot.memory_cache.resident_bytes`, container memory limit and AOT file-cache hit diagnostics. | Lower AOT memory limits to protect the process or raise them only within the container budget. The safe degradation is file-cache/SPA fallback; invalidation and disk artifact ownership remain enabled. |
| `security_blocker` | Production release is blocked by DAST, attack matrix, permission matrix or exposure evidence failures. | `.tmp/security/zap`, attack/permission matrix output, `.tmp/security/production-exposure-status.json` blockers. | Do not promote; keep the previous image and gateway config until every security blocker has passing evidence. |

## Backups

Use the site package script as the normal single-author backup entrypoint:

```bash
FSUSBLOG_BACKUP_RECIPIENT_FILE=/etc/fsusblog/backup-recipient.pem \
  tools/operations/backup-site.sh
```

The package includes PostgreSQL (`database.dump`), uploads, the already X.509-wrapped DataProtection keyring, redacted config, AOT cache and search artifacts. The only published output is a mode-0600 `.tar.gz.fsbenc` authenticated envelope (AES-256-GCM with RSA-OAEP-SHA256 key wrapping); the command never falls back to a plaintext archive. Set `FSUSBLOG_BACKUP_ROOT` to the production backup volume and keep the RSA public recipient outside that volume. The script accepts `FSUSBLOG_POSTGRES_URL`, `DATABASE_URL`, or `ConnectionStrings__DefaultConnection`; PostgreSQL values may use libpq URL style such as `postgresql://fsusblog:secret@db.internal:5432/fsusblog`, Npgsql style such as `Host=db.internal;Port=5432;Database=fsusblog;Username=fsusblog;Password=secret`, or libpq keyword style such as `host=db.internal port=5432 dbname=fsusblog user=fsusblog password=secret`. In the Npgsql form, `Username=`/`Password=` are database connection string keywords, not `Admin:Username`/`Admin:Password` application identity settings. The script redacts config keys matching secret/password/token/key/connection/string before packaging. Redis is a cache/control-plane dependency; restore uses a fresh empty Redis unless infrastructure policy provides a separate Redis persistence layer.

Restore is explicit and non-destructive unless `--confirm` is supplied:

```bash
FSUSBLOG_BACKUP_IDENTITY_FILE=/run/dr-identity/backup-identity.pem \
  tools/operations/restore-site.sh --backup backups/fsusblog-site-YYYYmmddTHHMMSSZ.tar.gz.fsbenc --dry-run
FSUSBLOG_BACKUP_IDENTITY_FILE=/run/dr-identity/backup-identity.pem \
  tools/operations/restore-site.sh --backup backups/fsusblog-site-YYYYmmddTHHMMSSZ.tar.gz.fsbenc --confirm
```

The restore script authenticates/decrypts before extraction, verifies the manifest recipient, all artifact digests, encrypted Data Protection XML and generation count, then restores PostgreSQL, uploads, keyring, AOT cache and search artifacts and writes a JSON report. The identity must be a mode-0600 regular non-symlink private PEM; it remains in the offline disaster-recovery secret domain. Sanitized config is extracted for operator review; secrets must be supplied from the target environment, not from the package.

Run a repeatable backup/restore rehearsal before treating the production closeout gate as complete:

```bash
tools/operations/backup-restore-drill.sh
```

By default the script runs in dry-run mode and writes `.tmp/operations/backup-restore-drill.json` with `status=scheduled`. That is useful for runbook rehearsal and exits successfully, but it is never a release closeout credential. A real drill must provide PostgreSQL, Redis, upload, AOT cache and search index backup paths, restore them into an isolated PostgreSQL/Redis/backend stack, then smoke anonymous public pages, admin login, Binary API, search and WebSocket notifications before recording RPO/RTO:

```bash
FSUSBLOG_DRILL_MODE=real \
FSUSBLOG_POSTGRES_BACKUP=backups/fsusblog-postgres.sql \
FSUSBLOG_REDIS_BACKUP=backups/fsusblog-redis.rdb \
FSUSBLOG_UPLOADS_BACKUP=backups/fsus-uploads.tar.gz \
FSUSBLOG_AOT_BACKUP=backups/fsus-aot-cache.tar.gz \
FSUSBLOG_SEARCH_BACKUP=backups/fsus-search.tar.gz \
  tools/operations/backup-restore-drill.sh
```

The real mode starts disposable restore containers, copies upload/AOT/search artifacts into an isolated webroot, starts a restored backend on `FSUSBLOG_DRILL_BACKEND_PORT` (default `5180`), verifies `/`, admin login, `/api/binary/article/list/home/1/5.aeds`, `/search/index.manifest.aeds` and WebSocket notification heartbeat, then removes the temporary stack unless `FSUSBLOG_DRILL_KEEP_WORK=1` is set. The drill also writes `backup-restore-manifest.json` with the allowed restore set, rebuild-required state and sanitize-before-restore classes, then runs the anonymous residue gate and writes `backup-restore-anonymous-residue.json`. The gate covers PostgreSQL legacy identity/raw-IP columns, Redis legacy user/session/cache keys, public search payloads, AOT/static artifacts, uploads manifests and the repository-wide historical residue checker. Any P0 residue blocks the drill; P1/P2 findings remain visible as warnings for release policy escalation. Release evidence requires `status=ok`, `mode=real`, concrete RPO/RTO values, all restore/smoke checks above, `anonymous-residue-gate:ok` and a clean residue report; a dry-run or partial drill keeps the manifest blocked.

Destructive schema Contract steps additionally use [`docs/schema-migrations/destructive-rollback-window-proofs.json`](schema-migrations/destructive-rollback-window-proofs.json). Before running Contract, confirm its registry inventory is current, the referenced commit has passed the 30-day window, N/N-1 qualification is green, and the quarterly backup/WAL/cross-region restore evidence is real rather than `scheduled`. An open window is not an override request: leave compatibility structures in place and retry after the window/evidence closes. See [the rollback-window runbook](schema-migrations/destructive-rollback-window.md).

When the source is a site package generated by `backup-site.sh`, pass it directly; the drill unpacks database/uploads/AOT/search and starts Redis with an empty data directory:

```bash
FSUSBLOG_DRILL_MODE=real \
FSUSBLOG_SITE_BACKUP_PACKAGE=backups/fsusblog-site-YYYYmmddTHHMMSSZ.tar.gz.fsbenc \
FSUSBLOG_BACKUP_IDENTITY_FILE=/run/dr-identity/backup-identity.pem \
  tools/operations/backup-restore-drill.sh
```

Site-package drills require at least two encrypted Data Protection generations so current/previous protector rollback remains demonstrable. Backup recipient rotation, identity retention and the no-restart failure path are defined in [Site Backup Envelope Encryption](security/site-backup-envelope.md); an envelope failure leaves the active runtime untouched and must be retried after custody/configuration repair.

The admin UI surfaces backup and drill status in `/user/manage/ops`; cache/AOT/search/sitemap status and manual rebuild controls live in `/user/manage/cache`; data drift checks, diff preview and safe fix application live in `/user/manage/integrity`.

Authoring-level content export is a lighter recovery path for editorial mistakes, not a replacement for database and upload backups. `GET /api/binary/author/articles/{articleId}/export` returns one Markdown document with frontmatter and base64url metadata; `GET /api/binary/author/content/export` returns a JSON package of all article exports. The metadata preserves category id, tag ids, cover URL, article status, scheduled publish time and revision records. Restore through `POST /api/binary/author/articles/import`; use `publish=false,preserveRevisions=true` for parity restores, or `publish=true` only when intentionally bringing the restored article online immediately.

## Migration Recovery

Before an offline migration, retain its authenticated site package, restore drill and exact database identity with the deployment note. Production `serve` performs current-receipt admission and must not acquire a migration advisory lock, create control tables or execute a descriptor. The release current-schema-admission stage only invokes the candidate-pinned read-only Server verifier; it never runs offline plan, apply or verify. Those commands are separately admitted through the sole migration executable. An absent receipt or unavailable offline capability is a refusal, not permission to fall back to the retired Server command. Large table migrations must retain their sealed operation/checkpoint inputs, actual postcondition evidence and verified recovery pair. The following build/test/drill commands are partial preflight only, not current migration or release qualification:

```bash
dotnet build src/backend/FsusBlog.Server.csproj --no-restore
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore
tools/operations/backup-restore-drill.sh
```

Legacy PostgreSQL upgrades from the 2026-05-17 profile are documented in `docs/database-migration.md`. When a real legacy dump is available, run:

```bash
FSUS_LEGACY_20260517_DUMP_GZ=.tmp/db_blog_20260517000000fjyfe.sql.gz \
FSUS_LEGACY_20260517_DUMP_SHA256=<sha256-of-decompressed-custom-dump> \
FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE=postgres:18-alpine \
FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE_ID=<docker-sha256-image-id> \
  tools/db/verify-legacy-upgrade-20260517.sh
```

The verifier delegates to the single `legacy-20260517-real-dump` producer. It
restores the dump into the schema migration integration test container, runs
`SchemaMigrationRunner.RunAsync()` twice, checks content, messaging, visit-log,
refresh-token cleanup, length alignment and migration-history idempotency, and
writes source/dump/PostgreSQL-bound semantic evidence. Ordinary integration
records this exact test as `not-selected`.

The current boundary is defined in [Online Database Migration Protocol](online-database-migration.md#current-runtime-and-release-boundary) and [Database Migration Runbook](database-migration.md). Former N/N-1, Expand/Backfill/Contract and bridge procedures are historical evidence, not active Server or release APIs. After activation, code rollback cannot recreate removed data: isolate the affected write path and use a verified matching backup/database pair or a forward repair. Never edit migration history, durable apply journals or progress rows to force readiness, and never discard resume evidence to satisfy a current-schema comparison.

### Retired runtime fallback milestones

The operator evidence map for upload-session root sweep, subscription HMAC cutover, article-content finalize, plain-cookie read removal, AOT sidecar hash, and one-time artifact-clear migration is `tests/backend/runtime-fallback-milestones.json`. Each item links its focused runtime test and records external release/migration/count observations separately from repository facts. The current rules live in this runbook, `docs/security.md`, `docs/database-migration.md`, and `docs/architecture/public-aot-artifact-storage-boundary.md`; no issue-level summary or per-pass release note is an authority.

Run the focused retirement owner during unified validation, but keep absent production observations `deferred-unverified`. No local source scan or historical GitHub claim may stand in for current release IDs, migration-history rows, exact database counts, or deployed-control absence. Roll back by selecting the previous compatible image/database pair or pausing the affected external action; do not restore any retired request-time fallback.

`/user/manage/integrity` is the post-migration drift check for article bodies/revisions, taxonomy references, comment chains, sessions and assets. Do not mark a migration complete while it reports unresolved error-severity checks unless the sealed release evidence documents the accepted manual repair.

## Supply Chain

Run the baseline dependency and build-chain scan before promotion:

```bash
tools/security/check-supply-chain-audit.sh
tools/security/generate-sbom.sh
```

The supply-chain script verifies npm and NuGet lock files, runs `dotnet list package --vulnerable --include-transitive`, runs production `npm audit --omit=dev --audit-level=high`, and checks documented security-sensitive backend dependency versions. The SBOM and audit summary are copied into release evidence when available.

## Author AI Assist

Author AI assist is an admin-only authoring tool and stays local by default. The endpoint writes `author-ai-assist` audit records and returns provider state to the editor so the author can see whether suggestions came from local fallback or an explicitly reviewed provider path.

| Setting | Required value for external provider |
| --------- | -------------------------------------- |
| `Authoring:AiAssist:Enabled` | `true` |
| `Authoring:AiAssist:Provider` | non-`local` provider id |
| `Authoring:AiAssist:AllowExternalProvider` | `true` |
| `Authoring:AiAssist:ExternalProviderReviewed` | `true` |

If any switch is absent, the response remains `externalProviderAllowed=false` and no unpublished draft content is sent outside the server process. A release that enables a real external provider must include security review evidence and an audit smoke showing the actor id, operation, provider mode and external-allowed flag in the audit payload.

## Post Deploy Smoke

After deployment, run the smoke runbook against the release preview or production URL:

```bash
FSUSBLOG_SMOKE_BASE_URL=https://fsus.blog tools/operations/post-deploy-smoke.sh
```

The smoke records automated `verifiedCoverage` for anonymous public pages, feeds, sitemap, robots and health probes. It also carries a `manualChecklist` for admin login, Binary API, notification stream, upload and Passkey/MFA follow-up, but checklist entries do not count as automated coverage. Use `FSUSBLOG_SMOKE_DRY_RUN=1` for local documentation-only verification; it writes `status=scheduled` with a `dry-run` blocker. Real release evidence must come from the deployed endpoint with `status=ok`, `dryRun=false`, no blockers and all required automated coverage present.

## Release Evidence

Test evidence is layered as `correctness`, `browser-contract`, and `diagnostic`. Ordinary
PRs and `production-correctness` must remain browserless. Each of the nine release logical
domains generates an independent projection receipt; `release-final` additionally consumes a
source/build/digest-bound Browser Contract receipt and reads historical release assertions
only from its exact seven correctness projection receipts. The two independent diagnostic
projection receipts for RBAC negative and AOT consumption are not target-only closeout evidence
and cannot change Production Summary. Projection consumers never reread producer artifacts or
execute fallbacks. Nightly/manual diagnostics use separate receipts, artifacts, and retention.
Browser install/launch/crash/disconnect, runner OOM/PID/FD exhaustion, and fixture/bootstrap
failure are recorded as `infra-failure`; they cannot be disguised as product assertions or
turned into a clean pass through full-suite automatic retries. The release-domain set and
receipt boundary are in [`testing/release-domain-projection-ledger.md`](testing/release-domain-projection-ledger.md);
operation and rollback order are in [`testing/issue-1151-evidence-governance.md`](testing/issue-1151-evidence-governance.md).

Collect machine-readable release evidence after gates and smoke:

```bash
tools/operations/collect-release-evidence.sh
```

The collector writes `.tmp/release-evidence/<release-identity>/manifest.json` and copies available security, operations, coverage, doc sync and gate-log evidence. With `FSUSBLOG_RELEASE_ID`, a full commit SHA and an image digest, the namespace binds all three identities; a timestamp-only namespace is a blocked diagnostic fallback, not a publishable release credential. Set `FSUSBLOG_RELEASE_MANIFEST`, `FSUSBLOG_RELEASE_ID`, `FSUSBLOG_RELEASE_SLOT`, `FSUSBLOG_RELEASE_ENVIRONMENT` (defaults to `production`), `FSUSBLOG_COMMIT_SHA`, `FSUSBLOG_IMAGE_REF`, `FSUSBLOG_IMAGE_DIGEST`, `FSUSBLOG_RUNTIME_MATRIX_EVIDENCE` and the three `FSUSBLOG_RUNTIME_PROFILE_*` identity values from the deployed manifest before collection. The collector embeds the validated manifest plus runtime slot as `releaseIdentity`; the sealed v2 manifest records the target environment and derives target topology from that slot and the selected runtime profile. A missing field or release/commit/ref/digest mismatch keeps `evidenceSummary.image.releaseIdentityStatus` failed and the evidence `collected-blocked`. The manifest status is `collected-ok` only when required evidence is valid; otherwise it is `collected-blocked` and `evidenceSummary` records which evidence is missing, scheduled or blocked. `collected-blocked` is schema-valid for production-ci-gate diagnostics, but it is not publishable; a missing runtime matrix is additionally rejected by the semantic checker rather than accepted as a complete blocked bundle. The collector and manifest checker semantically parse critical evidence instead of trusting file presence: release identity must match the outer commit and image digest, the sealed runtime matrix must match the release commit/profile and its collected sha256, backup restore must be a real drill, post-deploy smoke must not be dry-run, authenticated DAST must execute an active scan, Wasm fuzz must run at least one seed, fault injection cases must be injected, and short soak must report positive duration, sample count and p95. Production closeout remains fail-closed: DNS delegation/readiness, firewall policy and live exposure must come from the real production environment before production exposure closeout can close, and release-closeout-gate must run with `--require-ok`.

The manifest is also the security evidence index for the release. It records DAST/ZAP output, `attack-matrix.json`, `permission-matrix.json`, production exposure status, production exposure request, firewall policy evidence, DNS readiness, DNS delegation and live exposure evidence. `evidenceSummary.externalExposure.valid=false` is a valid release-blocking artifact state, not a promotion signal. `evidenceSummary.externalExposure.request` summarizes the request package status, blocker count, current blocker sources, next action sources, unblock plan sources/count, required hosts, delegation domains, required evidence keys, firewall source sha256 requirements, handoff check count, verification command names/count, returned closeout command count and closeout command fields so operators can triage from the manifest before opening the full request JSON. `artifactDigests` records sha256 digests for copied production exposure artifacts so a handed-off bundle can be checked without trusting the current working tree; firewall policy evidence also carries `evidenceSource.sourceSha256` for the raw cloud or UFW export used to generate the normalized policy. If an artifact is absent, its digest must also be `null`. Missing external evidence is represented as `null` in `securityEvidenceIndex` while the blocker detail remains in `production-exposure-status.json`; do not replace that with synthetic passing firewall or DNS data.

Evidence levels are intentionally split:

| Evidence | Level | Gate |
| --- | --- | --- |
| coverage summary, ZAP, authenticated DAST, Wasm fuzz, attack matrix, permission matrix, supply-chain audit, SBOM, load result, fault injection, short soak | CI/release-depth forced | `tools/test.sh production` and `tools/operations/check-release-evidence-manifest.mjs` |
| image digest, post-deploy smoke, real backup restore drill, SLO alert replay, DNS readiness/delegation, firewall policy, live exposure | release closeout | `tools/operations/collect-release-evidence.sh` records `collected-blocked` until real evidence is present |
| retention cleanup | scheduled drill | `.github/workflows/daily-operations-checks.yml` plus release evidence copy when a release run provides the artifacts |
| historical raw-IP lifecycle | monthly production-audit drill | `.github/workflows/monthly-ip-anonymization-scan.yml` plus a passing `fsusblog.ip-anonymization-report.v1` artifact |

When `tools/security/complete-production-exposure-closeout.sh` fails, it still writes `.tmp/security/production-exposure-evidence-request.json`, tries to refresh later DNS readiness/live evidence, writes `.tmp/security/production-exposure-status.json` when possible, refreshes the request package with `currentStatus`, `nextActions` and `unblockPlan`, and leaves the closeout status blocked. The request package includes the direct closeout command plus returned-evidence and returned-handoff closeout commands so an operator can continue from either a filled `returned-evidence/` directory or a returned handoff tarball. `unblockPlan` groups every blocker source with the blocker count, exact expected artifact names, evidence file paths and commands needed to produce or verify that source. Run `tools/security/write-production-exposure-evidence-request.sh` before handoff when you only need the request package without live probing. Run `tools/operations/collect-release-evidence.sh` after a failed closeout attempt to preserve that request, the blocked status, and the DNS readiness/delegation, live exposure and firewall evidence files that were available.

Run `tools/security/check-production-exposure-handoff.sh <manifest.json>` before sending the evidence bundle outside the repo. This verifies the request, status report and manifest request summary are aligned across status, blocker count, blocker sources, required hosts, delegation domains, next actions, unblock plan sources/count, required evidence keys/count, firewall source sha256 requirement flags, handoff check count, verification command names/count, returned closeout command count and closeout command fields. It also verifies the request includes `requiredEvidence`, `verificationCommands` and `handoffChecks` for direct closeout, returned evidence verification, returned evidence closeout, returned handoff closeout, release evidence collection and handoff verification; checks that `unblockPlan` covers every blocker source with artifact names, commands and blocker counts; checks that the manifest bundle contains copied request/status/live/DNS/firewall artifacts under the standard in-bundle file names; checks that those files match the configured source files when the source files exist; checks that each copied artifact matches its manifest sha256 digest; and rejects request paths that point at temporary self-test evidence.

To hand the blocked production exposure state to an external operator, export the already-verified release manifest as a self-contained handoff directory and archive:

```bash
tools/security/export-production-exposure-handoff-bundle.sh .tmp/release-evidence/<release-identity>/manifest.json
```

The exporter runs the handoff checker first, copies the release evidence directory, writes `handoff-summary.json`, writes `operator-checklist.json`, writes `returned-evidence/expected-evidence-manifest.json`, writes `SHA256SUMS`, self-checks the generated directory, then creates `.tmp/security/production-exposure-handoff/<timestamp>.tar.gz` plus a tarball checksum and self-checks the archive before reporting success. The summary preserves blockers, unblock plan, next actions, required evidence, verification commands, returned closeout command coverage and firewall source sha256 requirements; the operator checklist preserves the same blocker-source checklist, returned artifact names and closeout commands in a short machine-readable file for external operators; the returned-evidence manifest records source manifest/request sha256 metadata, the exact standard filenames, required hosts, delegation domains and returned-evidence subset of the unblock plan the operator must satisfy. Verify the exported directory before sending it out:

```bash
tools/security/check-production-exposure-handoff-bundle.sh .tmp/security/production-exposure-handoff/<timestamp>
```

The bundle checker accepts either the exported directory or the `.tar.gz` archive, verifies the archive `.sha256` by digest so the archive can be moved with its checksum file, verifies `SHA256SUMS`, checks the copied release manifest artifact digests against bundled files, and rejects unsafe archive member paths, unsupported archive entry types, symlinks, and any handoff summary, operator checklist, README or returned-evidence manifest whose unblock plan, required hosts, delegation domains, standard evidence filenames or closeout commands no longer match the request and handoff summary. It is still a blocked handoff artifact until real DNS/firewall/live evidence makes `complete-production-exposure-closeout.sh` pass.

When an operator returns the standard evidence files, validate that returned directory before attempting production closeout:

```bash
tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>
```

The returned directory can be the bundle's `returned-evidence/` directory after the operator fills in the real JSON artifacts. It must contain `production-firewall-policy.json`, `production-dns-readiness.json`, `production-dns-delegation.json` and `production-exposure-live.json`. The verifier derives the current production host/domain scope from `FSUSBLOG_LIVE_HOSTS` or the production env source, validates `expected-evidence-manifest.json` when present, rejects any returned request or expected manifest that narrows that scope, and rejects an expected manifest whose source metadata or returned `unblockPlan` sources/count, evidence keys, evidence file basenames, artifact names or commands no longer match the required returned file set. It then points the existing firewall, DNS, live evidence and status reporter at that directory. It refreshes `production-exposure-status.json` and `production-exposure-evidence-request.json` in place, collects a release evidence manifest for the returned files, and runs the handoff checker against that manifest. It exits non-zero while the returned evidence is still blocked, but leaves the status, request and manifest artifacts behind for the next handoff cycle.

After returned evidence validates as `ok`, complete production closeout from that same returned directory or from a returned handoff bundle:

```bash
tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>
tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>
```

Both closeout commands require `expected-evidence-manifest.json`, rerun returned evidence verification, then invoke the normal production closeout verifier against the returned live evidence and status report. The direct returned-evidence closeout also detects when the provided directory is `returned-evidence/` inside a full handoff bundle and preflights that parent bundle before it verifies returned files. The handoff-bundle command accepts either the whole handoff directory or a returned `.tar.gz` with adjacent `.sha256`, verifies the full bundle first when release evidence, `SHA256SUMS` or `handoff-summary.json` are present, locates `returned-evidence/`, requires the expected evidence manifest, and then delegates to the returned-evidence closeout. That full-bundle preflight catches rewritten release evidence, summary, operator checklist, README and expected manifest metadata before any returned file can complete production closeout, regardless of whether the operator passes the whole bundle or only its `returned-evidence/` directory. They refuse to report success while the returned status is blocked. If a returned tarball fails after extraction, the wrapper preserves the extracted evidence under `.tmp/security/production-exposure-returned-handoff/` by default so the blocked status/request artifacts can be inspected after the temporary extraction directory is removed.

## Retention Cleanup

Use dry-run cleanup to verify retention behavior before deleting local artifacts:

```bash
tools/operations/cleanup-retention.sh
```

The retention script records intended cleanup for release/security evidence, coverage, upload sessions and historical AOT/search files. Runtime `LogCleanupService` separately enforces database retention for visit logs, RUM metrics, ordinary audit logs, and `anonymous_credential_issuance_audit` rows older than 90 days. It must not delete article-referenced assets or the only copy of audit/security evidence required by the current release. `/api/binary/author/assets/orphans` marks only zero-reference `content_asset` records as `pending_delete` and places their AssetIds in `content_asset_cleanup_queue`. Physical files under `/uploads/illustration/` are handled separately by `ArticleAssetCleanupWorker`: current articles, server drafts and retained revisions are recorded in `content_asset_reference`; an asset receives a 24-hour queue grace period only after all source rows disappear, and the consumer claims by AssetId before `IAssetStore.DeleteAsync(AssetId)` rechecks references under the AssetId advisory lock and resolves the canonical storage record. See `docs/architecture/article-asset-reference-lifecycle.md`.

Upload asset file deletion is opt-in and guarded. Set `FSUSBLOG_RETENTION_SCAN_UPLOAD_ASSETS=1` only with a non-empty `FSUSBLOG_RETENTION_REFERENCED_ASSETS` file containing `/uploads/illustration/*` URLs; referenced files are counted as `assetGuard.protectedReferencedAssets` and are never deleted. The fixture test `tools/operations/test-retention-cleanup-fixture.sh` proves an old referenced asset survives while an old unreferenced fixture asset is removed.

When rotating `Moderation:RegionPolicy:IpHashKey`, old `comment_region_compliance.submit_ip_hash` values cannot be recomputed because raw IPs are not stored. Run `tools/security/rotate-region-ip-hash-pepper.sh` after deploying the new pepper to invalidate old hashes. The tool defaults to dry-run and requires `FSUSBLOG_CONFIRM_REGION_IP_HASH_ROTATION=INVALIDATE_OLD_REGION_IP_HASHES`; set `FSUSBLOG_REGION_IP_HASH_ROTATION_DRY_RUN=0` only after checking the row count.

## Disk Hygiene

- Serilog file logs are retained by app settings.
- Docker stdout/stderr logs are rotated by compose `json-file` options.
- AOT cache is a named volume; clean it during maintenance only after confirming public fallback still works.
- Do not commit `.env`, logs, coverage, Playwright outputs, local probes, or temporary build spillover.

## Incident Recovery

- JWT rotation mismatch: stop traffic promotion and route traffic back to the prepared previous blue/green slot; do not restart it or enable key try-all. Confirm current/previous `kid` coverage and bounded deadlines with [JWT signing-key rotation](security/jwt-key-rotation.md), then redeploy the candidate and repeat cross-slot ordinary/admin probes.

- App fails liveness: inspect container logs, then restart the app container.
- App fails readiness only: inspect `/api/ops/health/ready-detail` to distinguish DB, Redis, config, or resource failure.
- DB pressure: lower public traffic at the gateway, check DB concurrency gate detail, and inspect slow SQL logs.
- Redis outage: keep the app isolated from new traffic until readiness returns; public hot paths may degrade without L2 cache.
- WebSocket pressure: inspect readiness runtime detail and logs for slow consumer disconnects.

## PerceptionCharacterV3 stop and recovery

Formal cutover may only invoke `invoke-perception-character-v3-cutover.mjs` from
`release-rollout.sh` inside the `source-drain` active-release fence. Inputs must be the
current-build `perception-character-v3-release-target.json`, the immutable pool
`manifest.json` actually loaded by the candidate, and the current RiskControl `PolicyVersion`;
do not call the endpoint manually, open the marker in steps, or reuse a generic
challenge-kind operation ID. The command first writes a mode-0600 receipt, then requires
`status=activated`; retrying the same operation ID only reads the durable mutation/receipt.
The receipt contains only counts and release/slot/generation/contract/schema/policy/pool
bindings, not challenge ID, answer, token, media, IP, device, or user material.

1. Hot-reload `Security:PerceptionCharacterV3:Resources:AllocationsEnabled=false` and remove
   `perceptionCharacterV3` from the RiskControl policy; the former makes the next planner
   decision immediately queue/fail closed by action disposition, while the latter stops new
   ordered assignments; neither requires a restart.
2. Call binary cancel/revocation on the active envelope; confirm the audit terminal state is
   `revoked`; do not delete the Redis key or reset attempts.
3. Keep the public state `unavailable` on renderer/Redis/crypto failure; do not switch to a
   retired challenge, JSON, or in-process attempt state.
4. For key-ring failure, correct the secret with the previous valid version of the independent
   V3 token/answer ring, then rolling-restart. Key material in the two rings must never be equal;
   an active token with an unknown old version remains fail closed.

The only no-restart rollback after cutover is the two paths above: disable allocation and remove
the V3 policy. Do not restore the old pool generation, parser/codec/state reader, frontend
assets, or contract feature flag. Keep V3 closed if any active fence, receipt, marker, pool, or
policy is inconsistent; other explicitly configured challenge kinds, authentication, admin,
notification stream, and Binary API continue under their own policies.

Before restoring allocation, check the active generation's visual/audio/total ready,
watermark, leased/burned, revocation/corruption, minute/rolling-hour lease, and exact-byte
egress budget; do not manufacture “available capacity” by deleting an operation fence, burn
marker, or budget key. Offline replenishment is allowed only below the high watermark and
without CPU/memory/I/O/latency pressure, subject to per-run entries/bytes limits; a failed
staging generation must not replace the active generation.

Before deploying a resource-planner candidate, the current offline builder must generate a
manifest v1 generation with additive `artifactBytes`, and the candidate must point to it; old
runtime ignores the additive field, so rollback remains possible. The candidate rejects an old
generation missing exact-byte metadata; do not fill it from ciphertext length or post-deployment
decode estimates.

Anonymous device-authority Redis keys and challenge state are both fail-closed infrastructure;
do not clean only one side of the device lease or IP→device mapping. If a cookie is lost, the
same pseudonymous IP reuses the authoritative lease; a forged UUID does not automatically
create a new bucket. The spoken atlas is provided by embedded JSON; on startup-integrity
failure, do not fall back to runtime TTS, Morse, index tones, or V2 audio.

The reproducible spoken-atlas inputs are `perception-character-v3-spoken-atlas-source.json`
and the repository's `tests/fixtures/security/perception-character-v3-spoken-atlas-source-wav/*.wav`:
fixed per-symbol SSML, spoken label, eSpeak source-WAV hash, and resampled PCM hash/length;
an independent golden file then binds the source manifest and final atlas SHA-256. Normal
verification runs `node tools/contracts/generate-perception-character-v3-spoken-atlas.mjs --check`,
reads controlled WAVs fully offline, retrims/resamples them, and compares PCM and final atlas
layer by layer; local TTS installation is not required. Only when explicitly updating the
authoritative voice source may eSpeak NG **1.51** run
`--regenerate-source --espeak-ng <path>`; the script fixes `-m -v en-us -s 135 -p 45 -a 150`
and rewrites WAV/source/output/golden, after which every binary/hash change must be reviewed.

For local verification, first run `tools/test/perception-character-v3-redis-fixture.sh`; it
uses a disposable Redis 7 container to verify concurrent correct/incorrect attempts, the two
limits, replay, expiry, revoke, binding substitution, and unavailable fail-closed behavior;
then run the targeted backend suite and protocol vector generator `--check`.
## Host-local Production capacity reservation

FsusBlog and the FsusUI Production run on the same host must configure the same
`FSUS_PRODUCTION_CAPACITY_AUTHORITY_ROOT`. This directory must be outside each repository,
`.tmp`, run output, build root, and cache holding root, and exclusively owned by the current
operator account. If the authority is unavailable, the journal digest does not match, owner
identity is incomplete, or filesystem identity is unclear, do not clean up the workspace before
retrying.

When recovering an unfinished reservation, verify PID start identity, executable/command digest,
run/candidate, repository lease, and the complete process tree/Windows Job Object. Continue to
block when the owner has terminated but descendants remain; atomically archive as aborted only
when the complete tree has zero residue. Never guess reclamation by PID, process name, or mtime.

Capacity failure does not require an application restart: stop the current Production Fresh,
retain the checkpoint, logs, partial evidence, and host-local failure/release receipt, add host
capacity or correct the authoritative estimator, then run with a new run ID. Do not delete
historical evidence/cache, start GC, or enlarge the reservation to continue a run that already
experienced `external-capacity-loss` / `estimator-under-declared`.
