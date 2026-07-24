# Content-addressed Production restore/build cache

FsusBlog Production fresh keeps every dynamic correctness fact fresh while permitting deterministic restore and build outputs to be reused when their complete input identity is unchanged.

## Ownership

The cache owns only these domains:

- `dotnet-restore` — run-bound MSBuild/NuGet `obj` outputs;
- `backend-server-release` — Release server/shared/core/analyzer `bin` outputs;
- `backend-tests-release` — Release backend test `bin` output;
- `backend-benchmark-release` — Release benchmark `bin` output;
- `frontend-release` — frontend `dist`, governed WASM artifacts and the frontend build-stage receipt.

TRX, coverage, database state, runtime fixtures, scheduler checkpoints, release evidence and test outcomes are never cache objects. A cache hit therefore changes compiler work only; the current run still executes all tests and produces new dynamic evidence.

## Identity

Every domain key binds:

- the complete declared source/project closure and per-file SHA-256 records;
- SDK/tool versions, OS, architecture, libc/RID and declared build properties;
- a strict compiler-environment allowlist;
- the declared dependency graph and upstream cache receipts;
- generated contracts and the WASM producer inputs for the frontend domain;
- the semantic domain declaration itself.

A Git commit, file mtime or elapsed age is never sufficient. Cache objects have no time-to-live; identity equality and object integrity are the only reuse criteria.

## Publication and materialization

A producer acquires a per-key directory lock, writes to a staging root, computes the artifact tree digest and embedded receipt records, seals files and directories read-only, writes one atomic receipt, and atomically renames the staging object into place. A second producer may consume the completed object as `race-hit`; it may not publish a second ambiguous receipt.

Consumers validate the complete receipt, identity key, payload roster, hashes, embedded receipts and read-only boundary before materialization. Reflink/CoW is attempted first. Platforms without a supported clone operation use an explicit `copy-fallback` and record that mode in evidence.

Run-bound path text in eligible restore/frontend outputs is relocated from the producer run root to the consumer run root. Consumer-bound frontend stage and WASM receipts are then resealed through their existing authorities. Binary output containing an undeclared run-root path fails closed.

Corrupt, partial, writable, ambiguous or identity-mismatched objects are moved to the quarantine root and are not silently rebuilt in the same operation.

## Evidence

Each domain writes current-run evidence containing decision (`hit`, `miss`, or `race-hit`), reason, key, producer and consumer source identity, reused/built bytes, compiler invocation count, materialization/publication mode, relocation counts and duration. The run summary is complete only when every configured domain has successful evidence and explicitly records `dynamicFactsCached: false`.

The immutable Production artifact producer waits for this summary when it consumes run-bound build outputs. This prevents a partial build-cache run from being sealed as a complete Production artifact.

## Local operation

Production entry points invoke the cache automatically:

- backend restore/build commands pass through `tools/build-with-data-env.sh` in the `backend-tests` physical bundle;
- the run-bound Production environment preloads `frontend-build-cache-bootstrap.mjs`; it intercepts only direct `tools/frontend/build.mjs` execution in the `build-static` physical bundle;
- all other development and standalone invocations execute the original command directly.

The cache root and quarantine root live under `.tmp/`; deleting them is safe and does not delete dynamic test evidence.
