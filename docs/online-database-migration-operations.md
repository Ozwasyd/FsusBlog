# Online Migration Operations

## Stable rollout entry

The only production release entry is `tools/deployment/release-rollout.sh`. Its
fourth durable stage invokes `tools/db/run-online-migrations.sh --phase expand`
before candidate start and seals the result under the same rollout ID. Production
`serve` resolves `ServeSchemaCompatibilityRunner`, so startup/readiness only read
schema history and compatibility; they never acquire the writer lock or execute a
descriptor.

`tools/db/run-online-migrations.sh` is the rollout-owned migration helper and the
explicit operator entry for isolated Backfill/Contract maintenance. It never sources
the environment file or prints its values. The server DLL defaults to
`/app/FsusBlog.Server.dll` and can be overridden with `--server-dll` or
`FSUSBLOG_SERVER_DLL`. Do not invoke `expand` beside an active rollout, and do not
use the wrapper as a second general deployment entry.

```bash
bash tools/db/run-online-migrations.sh \
  --release-manifest /run/fsus/release-manifest.json \
  --env-file /run/fsus/server.env \
  --phase expand \
  --dry-run

bash tools/db/run-online-migrations.sh \
  --release-manifest /run/fsus/release-manifest.json \
  --env-file /run/fsus/server.env \
  --phase expand

bash tools/db/run-online-migrations.sh \
  --release-manifest /run/fsus/release-manifest.json \
  --env-file /run/fsus/server.env \
  --phase backfill-resume \
  --id 20260712-post-example-backfill

bash tools/db/run-online-migrations.sh \
  --release-manifest /run/fsus/release-manifest.json \
  --env-file /run/fsus/server.env \
  --phase contract \
  --evidence /run/fsus/contract-evidence.json \
  --dry-run

bash tools/db/run-online-migrations.sh \
  --release-manifest /run/fsus/release-manifest.json \
  --env-file /run/fsus/server.env \
  --phase contract \
  --evidence /run/fsus/contract-evidence.json \
  --confirm-destructive
```

The first two `expand` examples show the helper protocol; a normal production
release reaches the mutating form through `release-rollout.sh`. `backfill-resume`
may run between release windows because its durable token bounds each invocation.
`contract` is never automatic: run it only after the normal rollout has completed,
the observation/retention window has elapsed, N and N-1 no longer use the old shape,
and no slot transition is in progress.

The wrapper accepts only `expand`, `backfill-resume`, and `contract`, checks all
required files before process startup, and forwards arguments as an array. It emits
a single machine-readable JSON result from the server on stdout; structured logs
are routed to stderr and the normal file sink. Wrapper failures are also
JSON: `{"status":"failed","code":"schema_wrapper_*"}`.

The direct executable interface is:

```text
FsusBlog.Server serve [ASP.NET host arguments]
FsusBlog.Server migrate --phase expand [--dry-run] --release-manifest FILE --env-file FILE
FsusBlog.Server migrate --phase backfill-resume --id ID [--dry-run] --release-manifest FILE --env-file FILE
FsusBlog.Server migrate --phase contract --evidence FILE [--dry-run | --confirm-destructive] --release-manifest FILE --env-file FILE
FsusBlog.Server migrate --check --release RELEASE_ID --release-manifest FILE --env-file FILE
```

`--dry-run` is read-only: it does not acquire the advisory lock, create a control
table, write progress, or execute a descriptor. A mutating command takes the same
advisory lock as the historical runner before its first database write.

The 2-core/2-GB inter-batch delay is a low-resource **single-slot maintenance**
pacing rule. It does not certify a Blue/Green overlap. Zero-downtime release
qualification still requires the 4-core/6144-MiB/10240-MiB host floor and the
resource probe evidence.

## Environment file

The parser accepts blank lines, comments, `KEY=value`, and optional `export`. It does
not perform shell expansion, command substitution, or variable interpolation.
Double underscores map to .NET configuration separators; for example:

```dotenv
ConnectionStrings__DefaultConnection=Host=db;Database=fsusblog;Username=fsus;Password=...
FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE=20260719083000-0123456789ab
```

Keep the file readable only by the deployment principal. The command logs release,
phase, migration id, status, counts, and stable error codes, never configuration
values, connection strings, resume-token contents, or evidence bodies.

## Release manifest

The file must use `fsusblog.release-manifest.v2`; its `releaseId` must match the
requested/current release, and it must contain:

```json
{
  "schema": "fsusblog.release-manifest.v2",
  "releaseId": "20260720103000-abcdef012345",
  "schemaCompatibility": {
    "minimumCoordinate": "20260719083000-0123456789ab",
    "maximumCoordinate": "99999999999999-ffffffffffff"
  }
}
```

The full immutable manifest still carries commit and image digests. The online
migration reader consumes only the fields above; the release-manifest validator owns
the remaining immutability checks. `minimumCoordinate` and `maximumCoordinate` are
schema fences, not application versions. They accept canonical `ReleaseId`-shaped
coordinates plus the documented all-zero/all-maximum sentinels; they never accept
legacy free-form metadata. The previous rollback release is supplied by
`FSUSBLOG_PREVIOUS_ROLLBACK_RELEASE` and is mandatory for N/N-1 checks.

The database state table retains the physical `schema_release` column name only as
a persisted v1 compatibility detail. Its reader treats the value as a
`SchemaCompatibilityCoordinate`: canonical values are parsed directly, while the
explicit legacy adapter accepts only dated historical metadata and maps the two old
sentinels deterministically. Dated legacy values remain byte-for-byte identifiable;
old sentinels map only to the canonical min/max fence and never forge an
`AppliedByRelease`. Retire the adapter only after an audited migration proves that
no retained database or rollback snapshot contains legacy coordinates; rollback
before retirement keeps the old reader and column unchanged.

## Contract evidence

Contract evidence is a separate JSON file. A true value is an operator/control-plane
assertion backed by the named release evidence; the coordinator also evaluates
release fences and timestamps itself.

```json
{
  "currentReleaseUsesOldSchema": false,
  "previousRollbackReleaseUsesOldSchema": false,
  "backfillComplete": true,
  "backfillVerified": true,
  "observationStartedAtUtc": "2026-07-01T00:00:00Z",
  "backupRestoreVerifiedAtUtc": "2026-07-20T03:00:00Z",
  "slotSwitchInProgress": false,
  "destructiveChangeConfirmed": false,
  "rollbackManifestSealed": true,
  "oldWritesDisabled": true,
  "exclusiveModeEnabled": true
}
```

Keep `destructiveChangeConfirmed` false in stored evidence. The separate
`--confirm-destructive` CLI flag sets it only for that invocation. Contract dry-run
does not require the flag but still evaluates every other rollback-window gate.

## Machine result

Mutation and dry-run results use:

```json
{
  "status": "ok | paused | dry_run | failed",
  "releaseId": "20260720103000-abcdef012345",
  "phase": "expand | backfill | contract",
  "migrationIds": ["20260712-post-example"],
  "codes": []
}
```

`paused` is successful control-plane progress and includes
`schema_backfill_resume_required`. Reinvoke the same id. `failed` is non-zero and may
contain several independent gate codes so one run exposes all actionable Contract
or policy failures.

Check results include `status`, `publicErrorCode`, `releaseId`,
`schemaCompatibilityCoordinate`, and all protected issues. The coordinate must not
be presented as the deployed application version. Public readiness must map any non-ready report to HTTP 503 with
only `schema_incompatible`; protected admin diagnostics may serialize the issue
codes and migration ids from `OnlineSchemaCompatibilityRuntimeState`.

## Rollback and no-restart degradation

- Expand: keep old reads/writes and deploy the previous compatible release; additive
  schema remains harmless.
- Backfill: stop issuing the command. The durable token pauses progress without a
  server restart; compatible dual read/write remains active.
- Contract before execution: remove exclusive mode and keep old writes disabled or
  re-enable only the documented compatible bridge. Do not bypass a failed gate.
- Contract after execution: no code rollback can recreate removed data. Keep traffic
  off the affected write path and restore the verified backup into an isolated
  database, then use the deployment recovery procedure to select the compatible
  release/database pair.

Expand evidence remains part of the 15-stage rollout and therefore follows the same
`--resume` state. Contract evidence is intentionally separate; once a destructive
Contract is applied, mark the release/database boundary as non-rollback-compatible
and do not let gateway rollback select an old-shape image. A failed Contract command
must not rewrite a prior rollout's final evidence.

Never edit migration history or progress rows to force readiness. Unknown ids,
checksum mismatch, stale backup evidence, or a slot switch in progress are hard
stops.
