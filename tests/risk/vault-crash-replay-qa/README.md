# Bounded crash and replay QA

This directory contains independent diagnostic tests for operation persistence and
resolution admission. It is not a canonical test runner, a product executor or an
acceptance receipt. Production, registry, baseline and original owner test sources
are unchanged. The linked owner tests supply existing fixtures; their unit methods
are not rerun by these workers.

## Source binding and observations

- Requested operation source: `4b9b17d2fe36262ab04fcfac2d6e810d6718ca86`.
- Executed corrected published operation source:
  `8dca9343f1a8a88a4e8f266750e7844d0186335d`, draft owner PR #3973.
- Executed scalar-plan/journal source:
  `bb49a4c1f579ddf8630c67776d6cd9fa1f8c0661`.
- Canonical operation/materialization owner: #2106/#2107,
  implementation session `01a119f2-4617-746f-a19f-96aaee2c7033`.
- Canonical resolution/recovery owner: #2120/#2121,
  implementation session `01a119f2-cb4f-7434-8bb7-3363062f500f`.

The exact Server and recovery Shared builds exited 0. The original canonical
backend test command below exited 1 with existing `NU1004`; no lockfile was changed.
The diagnostic PostgreSQL command exited 0: seven composite groups passed. The
structural recovery worker exited 0: seven checks passed. No new product defect
was observed within those boundaries. SHA-256 source, assembly and raw evidence
bindings are in `evidence/source-binding.json`. Raw independent PID, checkpoint
digest, process exit and rejection observations are in `evidence/process-traces.json` and `evidence/after-insert-traces.json`.

The early operation source has no current-clock store check; the current published
owner source adds one. Its migration also adds an explicit non-null predecessor
constraint. The QA uses that corrected source; this is not evidence that the early
source or every owner contract is qualified.

## Reproduction

Use .NET 10.0.401, Python 3, Docker and `postgres:17-alpine`. Choose two isolated
clean source worktrees at the exact SHAs above and supply their absolute paths.
Build the actual published assemblies without modifying locked dependencies:

```bash
dotnet build "$VAULT_CRASH_REPLAY_OPERATION_SOURCE/src/backend/FsusBlog.Server.csproj" -p:RestoreLockedMode=true -v:q
dotnet build "$VAULT_CRASH_REPLAY_RECOVERY_SOURCE/src/shared/FsusBlog.Shared.csproj" -p:RestoreLockedMode=true -v:q
dotnet build tests/risk/vault-crash-replay-qa/VaultCrashReplay.csproj -p:VaultOperationSourceRoot="$VAULT_CRASH_REPLAY_OPERATION_SOURCE" -v:q
dotnet build tests/risk/vault-crash-replay-qa/recovery/RecoveryCrashReplay.csproj -p:VaultRecoverySourceRoot="$VAULT_CRASH_REPLAY_RECOVERY_SOURCE" -v:q
python3 tests/risk/vault-crash-replay-qa/run.py
python3 tests/risk/vault-crash-replay-qa/run.py --after-insert-only
dotnet tests/risk/vault-crash-replay-qa/recovery/bin/Debug/net10.0/RecoveryCrashReplay.dll export > /tmp/vault-crash-replay-recovery-fixture.json
dotnet tests/risk/vault-crash-replay-qa/recovery/bin/Debug/net10.0/RecoveryCrashReplay.dll verify /tmp/vault-crash-replay-recovery-fixture.json
```

Canonical command attempted on the operation source, not replaced by this harness:

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj -p:RestoreLockedMode=true --filter FullyQualifiedName~ArticleVaultOperationCheckpointPostgresTests -v:q
```

`run.py` allocates a task-owned PostgreSQL container, binds only an available loopback
port, applies the two unchanged descriptor SQL bodies to new task databases and
removes its container and anonymous volume in `finally`. It never uses the saved
development database. This directly tests the published stores; it does not start
the application or claim canonical current-schema migration integration.

## Expected boundaries

1. A process killed with SIGKILL after `AppendAsync` returns leaves one checkpoint.
   A separate process reads its exact digest; identical replay leaves one row.
   Killing/restarting PostgreSQL also preserves that committed checkpoint.
2. A process killed while PostgreSQL is waiting inside a test-only INSERT trigger
   leaves no partial append. A separate process can append from the sealed predecessor.
3. Four independent registration/append processes leave one identity and checkpoint.
   Rebinding the same request/idempotency digests to another deadline is rejected.
4. Competing execution/cancel appends from the same predecessor admit exactly one
   branch; the other exits 20 and cannot fork or overwrite the chain.
5. An unknown outcome cannot be cancelled or promoted to accepted using a nonexistent
   canonical result. Recovery retains the original base in every article outcome.
6. A real database role lacking checkpoint INSERT fails with `42501` and leaves the
   old history intact. A separate process cannot backdate execution past the current
   store clock deadline.
7. A separate recovery verifier process checks a canonical serialized structural
   chain, rejects stale tips/missing predecessors/expired plans and refuses execution
   and resume through the published missing-capability reasons. `Complete` without
   server/local/base references is rejected.

The operation clock is explicitly controlled to match the unchanged owner fixture;
it is not production wall-clock or host qualification. Recovery fixture references
are deliberately unbacked structural inputs. They prove no backup, native Git
observation, accepted server result or materialized file. The structural serializer
and original private scalar-fixture helpers are invoked through reflection only to
reuse their exact bytes and setup without duplicating their implementations.

## WIP and untested contracts

Actual accepted-server mutation interruption, local conditional writes, atomic
manifest/base commit, native resume/cancel, rollback/undo and backup cleanup remain
untested. The published materializer and recovery execution/durable-journal APIs
are missing; no substitute executor, mock durability proof or fabricated successful
receipt is provided. The recovery history check is pure contract validation, not
durable resolution-journal persistence. No native Windows/macOS/Linux agent or
offline host authority is qualified. The blocked canonical suite remains blocked.

Owner notifications: #2107 comment `6053414217`; #2121 comment `6053430324`.
