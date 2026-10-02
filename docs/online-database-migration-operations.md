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

The Server command retirement does not complete the release cutover. Existing
release-manifest compatibility coordinates, rollout Expand invocation, online
health report, and old-image rollback paths still require the
coordinated #2218 replacement. Until those prerequisites and consumers are closed,
they must not be treated as a working offline release protocol. Do not invoke the
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

## Recovery constraints

Permitted recovery is an unactivated candidate fallback, restoration of a verified
backup with its matching database identity, or a forward offline fix/migration.
Restoration and resumed migration require fresh independent verification and a
new receipt before admission. Never edit schema history or progress rows to force
readiness, and never start an old-shape image against a database already migrated
to the current schema.

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
