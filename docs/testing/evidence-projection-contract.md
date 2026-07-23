# Evidence Projection Contract

Logical test tiers do not always require independent physical test processes. A tier may consume a strict subset of assertions already produced by a canonical backend, frontend, or runtime owner, while retaining its own pass/fail decision, coverage responsibility, artifact declarations, and receipt.

## Execution modes

| Mode | Physical behavior | Evidence behavior |
| --- | --- | --- |
| `execute` | Runs the tier's declared test command. | The tier is its own physical owner and evidence source. |
| `projection` | Runs only `tools/test/project-evidence.mjs`; it must not launch a test runner or runtime probe. | Produces a tier-specific receipt from one canonical producer receipt. |
| `summary` | Joins already completed receipts without executing their producers. | Records closure and aggregate status only. |

The generated matrix documentation publishes three separate columns: execution mode, physical execution owner, and evidence source. The tier ID remains the logical evidence consumer.

## Projection declaration

A projection tier declares all of the following in `tests/matrix.yml`:

- `executionMode: projection`;
- `executionOwner` and `projectFrom`, bound to the canonical producer;
- a checked-in `projectionCatalog`;
- exact, sorted `requiredTestIds` and `requiredCoverageIds`;
- exact, sorted `requiredArtifactDeclarations`;
- `dependsOn` and `requiresEvidenceFrom` containing `projectFrom`.

Projection tiers are Node-only, low-cost I/O steps. They cannot declare bootstrap services, exclusive resources, .NET, Playwright, execution caches, or another command entry point. The matrix validator rejects incomplete or ambiguous declarations before scheduling.

## Producer and projection receipts

The canonical producer receipt binds:

- a full lowercase commit SHA and worktree SHA-256 fingerprint;
- run ID and namespace;
- unique assertion IDs, concrete source test IDs, outcomes, coverage IDs, and artifact IDs;
- repository-relative artifact paths and SHA-256 digests;
- a canonical content digest over the receipt.

The projector validates the receipt schema and digest, exact source/run/namespace identity, unique assertion and artifact IDs, every required `Passed` outcome, the exact coverage union, and each live artifact path and digest. Missing, duplicate, cross-run, cross-source, stale, failed, undeclared, or modified evidence fails closed.

Successful projection writes an independent `fsusblog.evidence-projection-receipt.v1` receipt. Its `executionBoundary` records zero child processes, `dotnet test`, Vitest, Playwright, and runtime probe launches. This receipt is the logical tier's evidence; the producer receipt remains the physical execution authority.

## Local verification

```bash
node tools/run-test-matrix.mjs validate
node --test tests/tools/evidence-projection.test.mjs
node tools/run-test-matrix.mjs docs
```

These checks require no remote workflow or external service. Projection never permits reuse across a source, worktree, run, or namespace boundary.

## Per-test observation ledger

The observation ledger is a separate projection of producer reports, not a logical-tier
pass/fail receipt. It normalizes four producer families into
`fsusblog.test-observation-artifact.v1`:

| Adapter | Producer input | Canonical identity inputs |
| --- | --- | --- |
| `xunit-trx` | VSTest/TRX `UnitTestResult` and `TestDefinitions` | class, parameterized display name |
| `vitest` | Vitest JSON report | source file, ancestor suites, assertion title |
| `node-tap` | Node TAP text | declared suite, assertion name |
| `playwright` | Playwright JSON report | file/line/column, suite/spec title; project remains a partition |

Each normalized record repeats its artifact's source commit, SHA-256 worktree
fingerprint, test/source closure digest, runner identity, run identity, attempt kind,
evidence class, and producer reference/digest. The validator rejects missing test IDs,
negative or non-finite durations, unknown outcomes, missing failure signatures, a
modified producer report, or any record-level binding that differs from the artifact.
The JSON Schema lives at
`config/schemas/test-observation-artifact.schema.json`; runtime validation additionally
checks the sealed artifact content digest and live producer digest.

Failure signatures hash normalized failure text. Normalization removes ANSI escapes,
temporary run roots, loopback ports, ISO timestamps, and generated run/worker IDs.
It retains exception/assertion text and source file line/column, so two failures that
differ only by runtime noise merge while different exception types, assertions, or
assertion locations remain distinct.

Example projection:

```bash
node tools/test-observations/cli.mjs adapt \
  --framework vitest \
  --input .tmp/test-results/vitest.json \
  --output .tmp/test-observations/vitest.json \
  --root "$PWD" \
  --evidence-reference .tmp/test-results/vitest.json \
  --suite frontend-unit \
  --partition unit-1 \
  --source-commit "$FSUSBLOG_TEST_SOURCE_COMMIT" \
  --worktree-fingerprint "sha256:$FSUSBLOG_TEST_SOURCE_FINGERPRINT" \
  --closure-path tests/frontend/unit \
  --closure-path src/frontend/vitest.config.ts \
  --run-id "$FSUSBLOG_TEST_RUN_ID" \
  --runner-os linux \
  --runner-arch x64 \
  --runner-runtime node-v24
```

`--closure-path` entries are sorted, constrained to `--root`, hashed individually,
then sealed into one closure digest. A precomputed `--closure-digest` may be supplied
by an existing authoritative source-closure producer instead.

An append-only local store and rebuildable index require no SaaS or database:

```bash
node tools/test-observations/cli.mjs ingest \
  --artifact .tmp/test-observations/vitest.json \
  --store .tmp/test-observation-history \
  --evidence-root "$PWD"

rm .tmp/test-observation-history/index.json
node tools/test-observations/cli.mjs rebuild \
  --store .tmp/test-observation-history \
  --evidence-root "$PWD"
```

`rebuild` emits per-test P50/P95 by nearest rank, outcome counts, signature counts,
source closures, and runner identities. No artifacts means an explicit
`coldStart=true` index, never a correctness failure. Timing is observational only:
one slow sample cannot fail a correctness gate.

The store does not embed raw reports. Duplicate artifact ingestion is a no-op keyed by
the artifact content digest. Operators may run `compact --max-age-days 180
--max-artifacts 2000`; artifacts outside either bound are removed and the derived
index is invalidated for rebuild. Compaction is explicit and local, and personal
history remains under ignored `.tmp/` storage rather than source control.

Synthetic fixtures for every adapter, malformed input, parameterized IDs, duplicate
names, cross-project partitions, signature normalization, binding rejection,
idempotent ingest, compaction, cold start, and full index rebuild run with:

```bash
node --test tests/tools/test-observation-ledger.test.mjs
```
