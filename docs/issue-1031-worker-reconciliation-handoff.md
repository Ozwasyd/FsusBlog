# Issue #1031 worker reconciliation drill handoff

This handoff covers the background-work and data-reconciliation part of issue
#1031. It adds a destructive rehearsal driver and its plan contract, plus an
explicit split between ordinary graceful reconciliation and the independent
destructive qualification verifier. Both paths are now wired by
`zero-downtime-rehearsal.sh` and the release rollout orchestration; this module
does not alter an application API.

## Delivered paths

- `tools/deployment/release-worker-drill.mjs`
- `tools/deployment/release-worker-reconciliation.mjs`
- `tests/tools/release-worker-drill.test.mjs`
- `tests/tools/release-worker-reconciliation.test.mjs`
- `tests/fixtures/deployment/release-worker-drill-plan.template.json`
- `docs/issue-1031-worker-reconciliation-handoff.md`

The driver emits `fsusblog.release-worker-event-ledger.v1`. Additional action,
observation, binding-provenance and failure fields are embedded in the ledger.
The verifier consumes those fields in `qualification` mode to prove that every
one of the nine kinds was pending before the forced stop, was observed only
after the stop, and committed exactly once on the target generation.

## What the drill actually does

The plan must contain exactly one definition for each of these worker classes:

- `scheduled-publish`
- `article-mutation-outbox`
- `audit-writer`
- `visit-view-projection`
- `public-hot-aot`
- `upload-cleanup`
- `active-singleton-control`
- `multi-consumer-safe-control`
- `forced-source-recovery`

Execution is fail closed and follows this order:

1. Read the durable rollout state and require the plan rollout ID, target release
   ID and target runtime generation to match it.
2. Prove the candidate target is ready through a real HTTP or read-only SQL
   observation.
3. Run every event's explicit HTTP/SQL prepare and trigger actions. SQL writes
   must be a single `INSERT` or `UPDATE` and must return exactly one
   `json_build_object` receipt. HTTP actions must return an allowed status and
   satisfy their response assertions.
4. Poll each event's pre-termination observation until durable pending work is
   observed. All nine event identities must be real, valid and unique.
5. Publish an `armed` signal and wait for a drill-bound authorization signal.
   No source termination occurs if any earlier action or observation failed.
6. After authorization, re-run target readiness and all nine durable-pending
   probes at the termination boundary. This prevents a stale pre-handshake
   observation from authorizing a kill after the source already consumed the
   work.
7. Force-stop the exact source container or the exact PID-bound source process
   with `SIGKILL`, verify that it stopped, then publish `source-terminated`.
8. Poll the target takeover observation and, after the source has stopped, run
   target wake/replay actions and final read-only observations.
9. Materialize every reconciliation field only from a named observation and
   JSON pointer. Missing, wrong-type or contradictory observations remain null
   or failing; the driver never fills a passing default.
10. Write the complete ledger to a new exclusive path. Existing ledger files are
    never overwritten; runtime and plan errors are accumulated without a
    maximum-error count.

The final event rows include the real logical event identity, kind, attempt
count, final-effect count/key, release ID, runtime generation, stale-generation
commit count, pending-at-drain count and durable replay source. Audit and visit
projection scenarios additionally include expected/actual counts. The forced
recovery row includes the observed target recovery result; its
`forcedSourceTermination` bit comes only from the driver's successful kill and
post-kill inspection.

## Anti-fabrication boundary

The `ledger` section of each event may contain only:

```json
{
  "attemptCount": {
    "probe": "final",
    "pointer": "/body/attemptCount",
    "type": "integer"
  }
}
```

There is no literal/value/expression binding. A plan cannot declare
`finalEffectCount: 1` or `staleGenerationCommitCount: 0` as evidence. It can only
assert those expectations against a response produced by a real observation,
and the observed value is copied into the ledger with the probe, pointer,
timestamp and SHA-256 provenance.

The observer used by the plan is part of the evidence boundary. It must derive
its response from durable database rows, worker attempt/lease records, active
fence identity and real asset/filesystem state. It must not merely echo request
fields or return a preassembled passing object. In particular:

- `attemptCount` comes from recorded claims/attempts;
- `finalEffectCount` and `finalEffectKey` come from the durable final side
  effect, not a requested expectation;
- `finalReleaseId` and `finalGeneration` are attributed to the worker that made
  the final commit;
- `staleGenerationCommitCount` is computed from source/target attempt records;
- the pending logical event ID, count and durable replay source are captured
  together before source termination and must match the final logical event;
- audit and visit expected/actual counts come from their durable stores;
- `recoveredByTarget` requires a source claim, no source final commit, and a
  target final commit after the forced stop.

The checked-in fixture is a plan **template**, not release evidence. Its
loopback `:19031` observer/action paths describe the required contract for the
repository-owned `release-worker-observer-service.mjs`. The central rehearsal
starts that service from a phase-specific materialized service plan and private
environment file; those inputs must point at the real isolated Test topology and
replace all rollout-derived values. A missing/404/static observer, unreadable
PostgreSQL/Redis/runtime state, or unresolved template makes the drill fail and
may not be converted to a pass artifact.

## Safety boundaries

The driver has no generic shell or arbitrary-command action. Its complete
external executable allowlist is `docker` and `psql`, both invoked directly with
`shell: false`.

SQL is constrained as follows:

- only repository-known tables may enter a plan allowlist;
- every write table must also be readable for reconciliation;
- reads must start with one `SELECT`, must reference a declared table, and may
  not contain mutation/administration keywords or sensitive PostgreSQL file and
  delay functions;
- writes must be one `INSERT` or `UPDATE`, target a declared table, and return
  one JSON receipt;
- comments, psql meta commands, multi-statements and schema/catalog escapes are
  rejected;
- template values use psql variable quoting and cannot replace table or column
  identifiers;
- read probes run with `default_transaction_read_only=on`.

HTTP origins are exact allowlist entries. Plain HTTP is restricted to loopback;
non-loopback traffic must use HTTPS. Credentials and fragments in URLs are
rejected. Sensitive header values must come from environment variables and are
not written to evidence.

All plan, rollout-state, signal, PID and output paths are confined to the trusted
drill root. By default this is repository `.tmp`; an external harness may set
`FSUSBLOG_WORKER_DRILL_ROOT` explicitly. Path traversal and existing symlink
components are rejected. Container names use a closed character set. Process
termination additionally requires a PID file inside the work directory and a
matching `/proc/<pid>/cmdline` marker before `SIGKILL`.

## Coordination contract

The safe default is `coordination.mode=file-handshake`. The driver atomically
writes:

```json
{
  "schema": "fsusblog.release-worker-drill-signal.v1",
  "rolloutId": "rollout-...",
  "runId": "worker-drill-...",
  "stage": "armed",
  "observedAtUtc": "2026-07-11T08:00:00.000Z"
}
```

The rehearsal orchestrator writes the same schema and exact rollout/run IDs to
`authorizeFile`, using `stage=terminate-source`. The signal timestamp must be
valid and no more than 15 minutes old. After verified termination, the driver
writes `stage=source-terminated` to `terminatedFile` with `forced=true`.

`immediate-destructive` exists only for an isolated fixture and requires
`explicitlyAuthorized=true` in the plan. It must not be generated by the normal
production rollout path.

This drill must not run as a synchronous step inside the normal successful
source-drain path: it intentionally kills the source and would conflict with
graceful drain accounting. The current central flow is a separate destructive
rehearsal:

1. start the candidate and prove target readiness;
2. start `release-worker-drill.mjs` and wait for its exact `armed` signal;
3. at the controlled gateway/active-fence transition, authorize source
   termination and continue target activation;
4. wait for `source-terminated`, target takeover and the final ledger;
5. prove target health, build the hash-bound qualification control and run the
   verifier in `qualification` mode without source-drain evidence;
6. retain the qualification artifacts and completely tear down the destructive
   topology;
7. start a fresh normal rollout, prove graceful drain separately and run the
   verifier in `normal` mode;
8. seal both runs only after their distinct rollout IDs and matching target
   release/image identities are proven.

## CLI and central wiring

The driver invocation is:

```text
node tools/deployment/release-worker-drill.mjs \
  --plan <generated-worker-drill-plan.json> \
  --rollout-state <durable-rollout-state.json> \
  --work-dir <directory-relative-to-drill-root> \
  --out <ledger-path-relative-to-work-dir> \
  --run-id <unique-run-id>
```

`--run-id` is optional; the driver generates a unique one when omitted. The
central rehearsal keeps it explicit so it can write exact coordination
signals.

The ordinary rollout uses `normal` mode. Its ledger contains the eight real
worker kinds and must not contain the synthetic `forced-source-recovery` kind:

```text
node tools/deployment/release-worker-reconciliation.mjs \
  --mode normal \
  --rollout-state <durable-rollout-state.json> \
  --ledger <normal-worker-ledger.json> \
  --source-drain <source-drain-evidence.json> \
  --target-health <target-health-evidence.json> \
  --out <worker-reconciliation-evidence.json>
```

`normal` requires exact rollout/source/target identity, passing target health,
graceful source drain, all eight worker kinds, drained-or-durable work,
exactly-once final effects, zero stale-generation commits, and complete audit
and visit/view projections. It does not execute or require a forced stop.

The destructive drill uses `qualification` mode and intentionally does not
consume source-drain evidence:

```text
node tools/deployment/release-worker-reconciliation.mjs \
  --mode qualification \
  --qualification-id <exact-worker-drill-run-id> \
  --rollout-state <qualification-rollout-state.json> \
  --ledger <qualification-worker-ledger.json> \
  --qualification-control <qualification-control.json> \
  --resource-policy deploy/zero-downtime-resource-policy.json \
  --target-health <qualification-target-health.json> \
  [--normal-rollout-state <completed-fresh-normal-rollout-state.json>] \
  --out <worker-qualification-reconciliation.json>
```

`--qualification-id` must equal `ledger.drill.runId` and must differ from the
qualification rollout ID. The verifier hashes the actual resource-policy file,
validates the qualification control and its ledger/scenario hashes, binds the
target release ID, image digest and runtime generation, and requires the
file-handshake termination boundary, real `SIGKILL`, target takeover after the
kill, and post-kill target commits for all nine kinds. `--source-drain` is
forbidden because a forced stop is not a graceful drain.

The optional `--normal-rollout-state` is a post-qualification check, not a
generation prerequisite. When supplied after the fresh normal rollout, its
rollout ID must differ from the destructive qualification rollout ID and its
target release ID/image digest must match. The alias
`--expected-normal-rollout-state` has the same behavior. Supplying neither is
valid while qualification is generated first; the result then records
`freshNormalRolloutRequired=true`, `normalRolloutReuseForbidden=true`, and
`normalRolloutSeparationVerified=false`, so the rehearsal finalizer must perform
the later identity/hash alignment before accepting the whole rehearsal.

Both modes emit `fsusblog.release-worker-reconciliation-evidence.v2` with an
explicit `mode`, the complete `requiredChecks` list, a named boolean `checks`
object, full source/target identities, immutable input path/size/SHA-256
references, counters, and every accumulated error without a maximum-error cap.
The top-level shape is:

```json
{
  "schema": "fsusblog.release-worker-reconciliation-evidence.v2",
  "mode": "normal | qualification",
  "status": "pass | fail",
  "requiredChecks": ["..."],
  "checks": { "...": true },
  "rolloutId": "...",
  "source": { "slot": "blue", "releaseId": "...", "imageDigest": "sha256:...", "runtimeGeneration": 1 },
  "target": { "slot": "green", "releaseId": "...", "imageDigest": "sha256:...", "runtimeGeneration": 2 },
  "forcedSourceRecoveryRequired": false,
  "forcedSourceRecoveryVerified": false,
  "qualification": null,
  "inputs": {
    "rolloutState": { "path": "...", "bytes": 1, "sha256": "sha256:..." },
    "ledger": { "path": "...", "bytes": 1, "sha256": "sha256:..." }
  },
  "errors": [],
  "observedAtUtc": "...Z"
}
```

In qualification mode, `qualification` additionally contains
`qualificationId`, `qualificationRolloutId`, `targetReleaseId`,
`targetImageDigest`, `targetRuntimeGeneration`, `qualificationPolicySha256`,
`resourcePolicySha256`, and the fresh-normal separation flags.

The v1 reconciliation schema no longer constitutes final #1031 evidence. The
normal v2 verifier output, not a destructive ledger, is the worker artifact for
the normal rollout. The separate qualification v2 output is sealed into the
rehearsal qualification evidence and then identity/hash-aligned with the fresh
normal rollout.

## Current orchestration readback and live input

The current rehearsal orchestration now generates phase-specific plans, coordinates
the destructive file handshake outside graceful source drain, tears down the
qualification topology, creates a distinct fresh normal rollout, runs both v2
reconciliation modes, checks different rollout IDs plus matching target
release/digest, and seals only the normal artifact into ordinary rollout evidence.

The remaining real-environment inputs are the phase-specific observer service plan
and private environment file (the template listens on `:19031`). The repository
service must read actual PostgreSQL, Redis, worker attempt/lease, container identity
and runtime-control state. A missing endpoint, 404, fixture-only echo server,
unreadable dependency or static pass JSON is a genuine qualification blocker;
this statement is not the stale migration-adapter gap. The migration qualification
adapter and its Test-only application routes are separately implemented and
documented in `issue-1031-migration-qualification-handoff.md`.

## Risk and rollback

The primary risk is intentional source termination. The file handshake is the
normal no-restart control: before authorization, the orchestrator can abort by
not writing the signal and can continue serving from the source. After
termination, the target must already be ready; gateway/fence activation and the
existing rollback/recovery entrypoint remain responsible for traffic ownership.
A failed drill artifact is retained as failure evidence and must never be
rewritten to pass. The topology should be restored by recreating the source slot
from its immutable manifest, not by editing the ledger.

No application API or security policy is changed here, so there is no runtime
feature flag or server restart requirement introduced by this module. The
operator can omit the separate destructive rehearsal from an ordinary rollout,
but a release gate that requires issue #1031 evidence must then remain blocked.

## Test code added and verification status

The Node test code specifies:

- exact nine-kind plan coverage;
- observation-only ledger bindings with no literals;
- audit, visit projection and forced-recovery special fields;
- SQL read/write/table/function/multi-statement boundaries;
- aggregation of independent plan errors without an error cap;
- exact `docker`/`psql` command allowlist and no shell execution;
- file-handshake and forced-stop contract presence.
- normal-mode eight-kind graceful reconciliation without forced-source proof;
- qualification-mode nine-kind post-SIGKILL target takeover with target,
  qualification-control and resource-policy hash binding;
- rejection of destructive/normal rollout ID reuse during the optional post
  check;
- preservation of every upstream error without a maximum-error cap.

Per the current implementation-phase instruction, no test, build, lint, syntax,
profile, checker or other validation command was run. The code and tests are
landed but remain unverified until the unified validation phase.
