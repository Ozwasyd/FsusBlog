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
- unique assertion IDs, outcomes, coverage IDs, and artifact IDs;
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
