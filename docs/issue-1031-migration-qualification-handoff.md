# Issue #1031 Online Migration Qualification Handoff

## Landed scope

`tools/deployment/release-migration-qualification.mjs` is an isolated-Test-topology
evidence producer for the online migration composition. It executes real argv arrays
and real loopback HTTP requests; it does not source shell text, accept production
origins, or treat a prewritten pass JSON as execution.

The fixed ten-case order is:

1. Expand while the old Active slot remains readable.
2. Overlapping Blue/Green reads and writes through both loopback runtimes.
3. Backfill start, bounded pause, hashed checkpoint, resume and completion.
4. Missing Expand keeps the candidate qualification check non-ready and the dedicated
   Test-only readiness route at 503.
5. Contract is rejected while the N-1 rollback window remains open.
6. A qualified Contract writes an explicit non-rollback-compatible marker.
7. PostgreSQL advisory-lock timeout fails with its stable code.
8. Database disconnection fails closed.
9. Partial Backfill failure retains its checkpoint and resumes without regression.
10. Checksum mismatch and an unknown migration-history record are returned together.

The scenario schema is
`fsusblog.release-migration-qualification-scenario.v1`; the complete template is
`tests/fixtures/deployment/release-migration-qualification-scenario.template.json`.
Every command is an argv array and binds its executable plus all declared input
files. Every command stdout/stderr is retained as a mode-0600 file and represented
by exact byte count and SHA-256. HTTP credentials are only read from a mode-0400 or
0600 single-line header file; request bodies are file-bound and neither credential
nor body is copied into final evidence.

## Exact CLI

```bash
node tools/deployment/release-migration-qualification.mjs \
  --scenario /run/fsus/release-migration-qualification-scenario.json \
  --rollout-state /var/lib/fsusblog/deployment/rollouts/<rollout-id>/state.json \
  --release-manifest /run/fsus/release-manifest.json \
  --work-dir /var/lib/fsusblog/deployment/rollouts/<rollout-id>/migration-qualification/<run-id> \
  --out /var/lib/fsusblog/deployment/rollouts/<rollout-id>/evidence/migration-qualification.json \
  --run-id migration-qualification-<unique-id>
```

The output path and work directory must not already exist. The tool validates the
immutable manifest against the exact rollout target release and image digest before
executing a case. The scenario, rollout state, manifest, executable, command inputs,
stdout/stderr, HTTP body inputs and final evidence are SHA-256 bound. Parsed command
output is reduced to stable migration/checkpoint fields so connection strings,
resume tokens and arbitrary response bodies do not enter the artifact; checkpoints
must expose `resumeTokenHash`, never the raw token.

## Repository adapter and Test-only bridge

The external-adapter placeholder has been retired. Plan materialization now binds
`REPLACE_QUALIFICATION_ADAPTER` to the repository-owned
`tools/deployment/rehearsal-schema-qualification-probe.mjs`. The adapter implements
checkpoint projection, bounded pause, advisory-lock timeout, isolated database
disconnect, partial failure/recovery, history tamper and the post-Contract rollback
marker. It runs only when both `ASPNETCORE_ENVIRONMENT=Test` and
`FSUSBLOG_ROLLOUT_REHEARSAL=1` are present, rejects database isolation IDs containing
`prod`/`production`, and reads a mode-0400/0600 environment file. It remains
qualification infrastructure, not a production migration entry.

The application also owns two real loopback qualification routes:

- `POST /api/release-evidence/schema-bridge/write` performs a bounded idempotent
  Blue/Green bridge write. The body is `{operationId,sequence}`; `operationId` is
  3..96 ASCII letters/digits/`-_.`, and `sequence` is 1..1,000,000.
- `GET /api/release-evidence/schema-qualification/readiness` returns
  `200 {status:"ready",code:"ok"}` or
  `503 {status:"not_ready",code:"schema_incompatible"}` after the isolated
  missing-Expand injection.

Both routes are absent unless the environment name is exactly `Test` **and**
`SchemaMigration:QualificationEnabled=true`. Compose receives the latter through
`FSUSBLOG_SCHEMA_QUALIFICATION_ENABLED`; the rehearsal sets it only for its isolated
topology. Even when mapped, both routes require admin `system.config` and the
`fixed_ip` limiter, return `Cache-Control: no-store`, and bind
`X-Fsus-Release-Id` / `X-Fsus-Release-Slot`. They are never a public production API.

The operator plan carries the actual repository inputs under:

```text
target.migrationServerDll
migrationQualification.scenarioTemplate
migrationQualification.timeoutSeconds          # 60..1800
migrationQualification.expandMigrationId
migrationQualification.backfillMigrationId
migrationQualification.contractMigrationId
```

`zero-downtime-rehearsal.sh` materializes the exact ten-case scenario, starts a
separate Test topology, holds the candidate at readiness, runs the qualification,
then releases or tears down that topology. Source/target response headers must match
the rollout identities; a fixture body or prewritten pass document is not accepted.

## Evidence and failure behavior

The final schema is `fsusblog.release-migration-qualification-evidence.v1`.
Expected negative commands pass only when their exact non-zero exit and stable codes
match. All ten cases continue so independent failures are collected in one run;
errors are deduplicated but never capped or tail-truncated. A successful Contract is
not sufficient by itself: the separately executed marker must bind the rollout and
target release and state `contractApplied=true, rollbackCompatible=false`.

Direct ownership:

- `tools/deployment/release-migration-qualification.mjs`
- `tools/deployment/rehearsal-schema-qualification-probe.mjs`
- `src/backend/Modules/Endpoints/ReleaseSchemaQualificationEndpoints.cs`
- `tests/backend/Unit/ReleaseSchemaQualificationEndpointsTests.cs`
- `tests/tools/release-migration-qualification.test.mjs`
- `tests/tools/rehearsal-schema-qualification-probe.test.mjs`
- `tests/fixtures/deployment/release-migration-qualification-scenario.template.json`
- `docs/issue-1031-migration-qualification-handoff.md`

No validation or Git operation was run while landing this code.
