# Migration Operations

## Server command boundary

The Server executable is not a schema migration entry. Its production command
grammar is owned by `Infrastructure/Operations/ServerCommand.cs`:

```text
FsusBlog.Server serve [ASP.NET host arguments]
FsusBlog.Server passkey-projection --check [--env-file FILE]
FsusBlog.Server passkey-projection --repair --confirm-repair [--env-file FILE]
```

Omitting `serve` preserves ordinary ASP.NET host arguments. The Server rejects
`migrate`, `plan`, `apply`, and `verify` before constructing the application. Old
migration options such as `--phase`, `--id`, `--release-manifest`, `--evidence`, and
`--confirm-destructive` are also rejected in either serve form, including
`--name=value` spelling. Passkey maintenance does not accept migration options.
It neither registers nor resolves the online migration command host.

Passkey repair requires explicit `--confirm-repair`; a manually constructed repair
command without confirmation is rejected before calling the projection service.
Check and repair retain their existing projection semantics. Command failures emit
a stable machine-readable error code, not environment values or exception details.

The two current-schema materialization commands remain isolated test-fixture
entries. They are not operator migration commands or evidence that an existing
production database has passed offline migration.

## Environment file

The passkey command parser accepts blank lines, comments, `KEY=value`, and optional
`export`. It performs no shell expansion, command substitution, or variable
interpolation. Double underscores map to .NET configuration separators:

```dotenv
ConnectionStrings__DefaultConnection=Host=db;Database=fsusblog;Username=fsus;Password=...
```

Keys are case-insensitive after that mapping; duplicate keys, malformed lines,
and invalid key characters fail closed. Keep the file readable only by the
deployment principal. Never source this file through a shell or log its values.

## Offline migration and release boundary

Schema transformation belongs to the single offline migration owner under
`src/migration/`, not the Server or a deployment wrapper invoking a Server migration
command. The immutable plan, crash-safe apply checkpoints, and independently
verified current-schema receipt are separate prerequisites tracked by #2215,
#2216, and #2217. A plan or apply terminal alone is not a current-schema receipt.

Release admission must consume the verified receipt and the exact deployment
candidate identity. It must run the candidate-pinned read-only Server verifier
against the actual target database; JSON status or caller-supplied hashes are not
substitutes for that observation. The receipt's producer source revision and the
deployment candidate revision are distinct identities: the candidate must freshly
derive and match the target and actual database observations.

The Server command retirement does not complete the release cutover. Current-only
manifest, health and rollout consumers replace the old release-time compatibility
window, but genuine receipt issuance, native observations and qualification remain
separate prerequisites. Until those prerequisites and consumers are closed,
they must not be treated as an accepted offline release protocol. Do not invoke the
old Server migration examples or use their compatibility window as release
authorization.

`tools/db/run-online-migrations.sh` is retained only as a refusal tombstone for old
callers. It emits `schema_wrapper_retired` and exits non-zero before reading
manifest/environment/evidence files or launching any executable, regardless of
phase, dry-run, resume token, or destructive confirmation. It is not a second
migration CLI. A rollout still calling its obsolete Expand stage must stop; this
refusal must never be recorded as a completed migration or converted into success.

The Test-only qualification routes temporarily remain registered for exact route
inventory consumers, but refuse every request: bridge write returns HTTP 410 with
`schema_qualification_retired`; compatibility readiness returns HTTP 503 with
`schema_incompatible`. They have no database or coordinator dependency and cannot
create the old bridge table, upsert an old-shape record, or grant readiness.
Their final removal requires the original route-inventory producer update; route
presence is not compatibility support or receipt verification.

## Read-only current receipt command

The candidate's Server executable exposes `current-schema-check --receipt
<absolute-file> --receipt-sha256 <exact-whole-file-sha256>
--candidate-source-revision <exact-40-hex-candidate> --env-file <absolute-file>`.
All four inputs are explicit; duplicates, missing values, relative paths,
noncanonical identities, mutation flags and unknown options are rejected before
host construction. The command calls the original
`CurrentSchemaReceiptAdmission.VerifyAsync`, re-reading the bound artifact and
the actual database/current target using the candidate assembly. It never parses
the offline execution plan, performs migration writes, or publishes startup
readiness. Its output uses the canonical receipt codec for status, target and
database identities, plus the observed artifact hash and candidate source revision.

This observer consumer is not a receipt issuer or a release grant. The rollout
consumer must still compare its actual output to the immutable release inputs;
the manifest, rollout-stage and health integration is not completed merely by
adding the command. Missing original source/backup/native-operation capabilities
remain blockers to genuine production receipt issuance and acceptance.

## Current-only release manifest

`fsusblog.release-manifest.v3` replaces the compatibility-window manifest. Its
`currentSchema` contains only the original receipt artifact `reference` and raw
whole-file `sha256`, the shared current five-field `target`, three-field `database`,
and independent physical `actualSchemaDigest`. Target `contentDigest` is semantic
and must not be substituted for the physical schema observation. The candidate
build remains bound by the original manifest `commitSha`, immutable image and
toolchain/runtime profile fields. The receipt verifier's historical producer
revision need not equal the deployment candidate revision.

The original creator uses explicit `--current-receipt-reference`,
`--current-receipt-sha256`, `--current-model-version`, `--current-extractor-version`,
`--current-generator-version`, `--current-source-digest`, `--current-content-digest`,
`--current-provider`, `--current-instance-id`, `--current-database-id`, and
`--current-actual-schema-digest` arguments. Provider values follow the shared closed
numeric enum; structural recognition of MySQL or SQLite does not supply a missing
native observer. The old min/max coordinate arguments and legacy rollback reader
are retired. v1/v2 manifests must be rebuilt from the original exact current receipt
and candidate inputs, not silently converted or accepted through fallback.

Manifest validation and its v2 deploy-input output are reference/identity checks,
not actual database admission (`admissionVerified` is false). They neither issue
a receipt nor parse a sealed migration plan. The rollout executes candidate-pinned
fresh Server verification before its first mutable work and again on resume and
before each stage. It does not execute the retired Expand entry or convert its
refusal into success.
Previous frontend/static-asset retention remains separately governed and cannot
authorize image rollback on a migrated database.

## Current-only rollout and retained evidence

The rollout state and stage/final evidence use v2. State binds the raw SHA-256 of
the complete manifest bytes, the candidate Git revision and the exact current
receipt/target/database/physical-schema references. Old v1 state cannot be resumed
or automatically resealed. Recovery requires the original exact authorized inputs,
a fresh native read-only admission and the same durable target identity; after
activation, image-only restoration of the old source is forbidden.

Before a lock, state, probe or slot mutation, `release-rollout.sh` runs the
manifest's digest-pinned Server image with `current-schema-check`. It mounts the
explicit environment and receipt read-only, retains the image's existing user,
and compares all six output fields to the immutable manifest bindings. Missing
files, unreadable permissions, unknown native capabilities, mismatched candidate,
target, database or physical observation refuse. Manifest and receipt bytes are
rechecked after the command. Resume and completed-stage skipping require fresh
admission; prior startup state or a cached JSON status is not substituted.

The dry-run is structural planning only (`admissionVerified: false`) and does not
acquire the host lock. The fixed 15-stage sequence replaces only Expand with
`current-schema-admission`; six final artifacts and 24 auxiliary references remain
mandatory. Successful current-admission stages and attempts retain hash-bound
Server stdout, independently replayed against the same binding. The final consumer
also verifies the actual copied manifest bytes and all existing safety, security,
traffic, resource and target-fence conditions. This is source integration, not
evidence that those commands or production gates have executed successfully.

`zero-downtime-rehearsal.sh` consumes an explicit
`fsusblog.zero-downtime-rehearsal-plan.v2` in an already isolated Test topology.
Only an explicit `normal` or `resume` invocation is operational. The plan binds
whole manifest bytes for both current source and target, their current receipts,
the same target/database/physical schema, private environment and authentication
files, durable slot/rollout paths and all original release evidence inputs. It
does not execute offline plan/apply/verify or create a replacement migration
authority. Before release work and on resume, both digest-pinned Server images
perform fresh read-only admission; only uniquely labelled admission containers
created by this invocation are removed. Command bytes and failed terminal reports
are retained. Success additionally requires durable current rollout completion
and replay of all 15 stages, six artifacts and 24 auxiliary references.
Command stdout/stderr stream to invocation-owned raw files rather than accumulating
in memory. Typed reads use the existing receipt limit or exact Docker identity
projection bounds. Cleanup reuses the original process policy, verifies kernel
group/start identity and invocation ownership before signalling, and requires two
fresh zero-live-member observations; missing identity or pipe closure is a failed,
retained terminal, not native process-tree qualification.

The summary's `current-release-consumption` scope is not offline migration,
real-provider crash/recovery, restored-backup, performance or complete issue
qualification. Those domains require their original actual evidence. Historical
v1 library fixtures remain recording evidence only; v1 operational plans and
image-rollback/all/SIGKILL qualification modes are rejected, not auto-upgraded.
Absent original #2215–#2217 issuer/native prerequisites remain fail-closed, not
synthetic successful qualifications. Component recording actors exercise the
consumer protocol but cannot issue receipts or establish native qualification.

## Current-schema health consumer

Production protected readiness detail uses `currentSchema`, not an online
compatibility coordinate/window. It first requires the actually published startup
`CurrentSchemaAdmissionState` and exact configuration/deployment candidate and
artifact bindings. It then uses the same read-only admission API in a fresh scope
to re-observe the current database and target; old online reports, empty state,
matching hash strings without the original observer, and observation drift cannot
grant readiness. Public `/health/ready` continues to expose only status, checkedAt
and the stable `schema_incompatible` failure code, never receipt paths, database
identity, candidate or target digests. This new observation cost still requires
the original real-provider and performance gates; source coverage is not a budget
or runtime acceptance result.

## Recovery constraints

Permitted recovery is an unactivated candidate fallback, restoration of a verified
backup with its matching database identity, or a forward offline fix/migration.
Restoration and resumed migration require fresh independent verification and a
new receipt before admission. Never edit schema history or progress rows to force
readiness, and never start an old-shape image against a database already migrated
to the current schema. The old `gateway-rollback.sh` and
`release-rollout-recovery.sh rollback-to-source` paths now refuse before reading
state or launching an executable. Internal `gateway-switch.sh --kind rollback`
also refuses before acquiring the deployment lock or changing an upstream.
The outer `release-rollout.sh --rollback` option refuses during argument parsing,
including dry-run/resume/no-switch combinations. A persisted legacy rollback or
old-source rollback recovery cannot be resumed as a deploy. Its old synthetic
`not-required-for-rollback` Expand success evidence is no longer produced. The
new `current-schema-admission` stage is a fresh read-only observation, not a skipped
migration or a successful offline apply. The retired Expand wrapper still fails
when invoked independently.

If a candidate has not activated, the same `gateway-switch.sh` invocation may
preserve the existing source upstream without restarting an image. After target activation, the gateway
does not automatically restore source traffic on reload/probe/commit failure, or
after an activation request with an unconfirmed response: it
retains failure evidence and requires verified database restore or forward
recovery. A recorded previous release, a healthy image, or a monotonic generation
is not a current-schema/database admission receipt.

Restart recovery cannot infer that activation never happened from a healthy old
image or a currently Ready target. `gateway-recover.sh --action restore-source`
refuses, automatic recovery does not select old-source fallback, and persisted
legacy rollback transitions are rejected. Forward target recovery keeps its
existing identity and lifecycle checks, but never restores saved source upstream
bytes after activating the target. These gateway controls do not themselves
issue a new current-schema receipt. The source now invokes the candidate-pinned
fresh Server observer before activation and on durable replay; actual provider,
admitted post-runtime collector and production deployment acceptance remain pending.

Historical migration descriptors and migration regression fixtures remain owned
by the offline migration assembly. Retirement of a Server entry is not permission
to delete them or to introduce a second schema authority. Frontend/service-worker
release compatibility and retained static assets are separate from database
compatibility and remain under their existing owners.

## Verification boundary

Command parser and passkey-host regression tests cover rejection before service
execution and preservation of passkey confirmation and literal configuration.
They do not establish real provider startup, zero database writes, release
admission, rollback restoration, performance, or residue-zero acceptance. Those
claims require the original PostgreSQL/MySQL/SQLite, release, mutation, and
independent terminal evidence specified by #2218 and the parent migration work.
## Final-image current receipt references

`tools/build-final-image.sh` retains its original build/publish owner and toolchain gates. A registry-publishing build must explicitly provide `FSUSBLOG_CURRENT_SCHEMA_RECEIPT` (canonical absolute regular file, no symlink aliases) and `FSUSBLOG_CURRENT_SCHEMA_RECEIPT_SHA256` (raw lowercase SHA-256 of the complete artifact bytes). The original 1 MiB receipt bound applies. The producer projects the existing current target, database and physical-observation fields into manifest v3; it does not issue a receipt, verify its semantic seal, observe a database or grant deployment admission. The sole Shared codec and candidate Server's fresh read-only admission remain mandatory.

The same whole-byte reference is checked before build work, immediately before registry publication and again when the manifest is emitted. Any missing, malformed or changed reference fails closed; no compatibility-window default or auto-upgrade is available. `FSUSBLOG_SCHEMA_MINIMUM_COORDINATE` and `FSUSBLOG_SCHEMA_MAXIMUM_COORDINATE` are retired. Local-only image builds still emit no deployable manifest and reject deployment receipt inputs. The image's manifest-schema label is v3; original build-input/observation producers must bind this changed Dockerfile through their normal gates before deployment.
