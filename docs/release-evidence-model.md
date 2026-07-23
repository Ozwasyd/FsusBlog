# Release Evidence Model

`release evidence` is reserved for fresh output bound to one immutable release identity. Historical reports, implementation attestations and fixtures are useful inputs, but none of them is a release credential.

## Contract, schema, receipt and handoff boundary

Release documentation has four non-interchangeable layers:

1. **Current contract** defines stable behavior, field meaning, failure handling and operator choices. Current contracts live under semantic `docs/` paths.
2. **Evidence schema** defines machine-verifiable input and output shapes. Schemas live in `security/evidence-contracts/`, `config/` or controlled `tests/fixtures/`; a schema is never proof of execution.
3. **Execution receipt** records one run ID, immutable identity, counters, timestamps, observed results and artifact digests. Receipts live in `.tmp/release-evidence/<release-identity>/` during collection and in the configured immutable artifact store after closeout.
4. **Implementation handoff** records branch coordination, shared-file ownership, commands not run and next-thread work. It belongs in issue/PR history and is not a repository document or evidence input.

A Markdown file cannot substitute for a schema or receipt. Current docs must not contain a run-specific pass claim, synthetic zero count, unexecuted validation list or permission limitation. A tracked fixture, implementation attestation or historical report cannot be promoted to fresh evidence by changing its filename or `status` field.

## Evidence classes

| Class | Canonical location | Fresh or release-gate authority |
| --- | --- | --- |
| `contract` | `security/evidence-contracts/` | No; declares required behavior or storage policy |
| `fixture` | `tests/fixtures/evidence/` | No; controlled test input only |
| `implementation-attestation` | `security/evidence-contracts/` | No; records focused implementation state |
| `historical-report` | `docs/reports/` | No; dated and revision-scoped provenance |
| `fresh-run-evidence` | `.tmp/` | Fresh invocation output, but not necessarily release-bound or passing |
| `release-closeout-evidence` | `.tmp/release-evidence/<release-identity>/` and immutable storage | Yes, only after full identity matching and `--require-ok` |

Every tracked contract, fixture, attestation and historical snapshot manifest declares `evidenceClass`, `freshExecution`, `releaseBound`, `productionFreshRun` and `generatedFrom`. Static classes must set all three booleans to `false`. Checkers reject contradictory classification, so a tracked JSON file cannot satisfy a fresh production requirement by being renamed or reporting `status: ok`.

## Physical producers and logical projections

Fresh evidence may be produced once and consumed by more than one logical tier. This is permitted only through the fail-closed contract in [`docs/testing/evidence-projection-contract.md`](testing/evidence-projection-contract.md). The canonical producer remains the physical execution owner; each projection remains an independent logical consumer with its own exact assertion, coverage, artifact, and pass/fail receipt.

A projection is valid only inside the same full commit, worktree fingerprint, run ID, and namespace. The projector verifies producer and artifact content digests and records that no test runner or runtime probe was launched. File existence, log text, timestamps, historical issue evidence, and cross-run receipts are never sufficient. Release closeout consumes the tier-specific projection receipt together with its producer binding, so projection changes execution topology without weakening evidence authority or retention.

## Historical reports

The v1.1.0 public-preview readiness campaign is retained under `docs/reports/open-source-readiness/v1.1.0-public-preview/`. Every Markdown report carries a historical banner. `snapshot-manifest.json` records the time window, the revision where it was originally recorded, the limited scope of that revision claim, and every retained artifact hash. Historical green values do not describe current master.

Current open-source scanner output is written to `.tmp/open-source-readiness/` and is not committed by default.

## Release-bound collection

`tools/operations/collect-release-evidence.sh` remains the collector. When `FSUSBLOG_RELEASE_ID`, a full commit SHA and an image digest are available, its default output namespace is:

```text
.tmp/release-evidence/<release-id>--<commit-sha-12>--<image-digest-12>/
```

Timestamp fallback is used only when no release ID exists and cannot become release closeout evidence. The collector continues to preserve blocked and scheduled states; no classification changes an unavailable external check into success.

After collection, `seal-release-evidence-bundle.mjs` inventories every copied regular file, records its byte count and SHA-256, rejects symlinks, and writes a canonical artifact-set digest into `manifest.json`. `check-release-evidence-manifest.mjs --require-ok` remains the semantic closeout authority and additionally requires:

- `release-closeout-evidence` classification;
- release ID, full commit SHA and immutable image digest agreement;
- an ISO UTC generation time, numeric workflow run/attempt identity, and explicit target environment;
- target topology matching the selected release slot and runtime profile;
- an identity-bound namespace;
- exact artifact inventory hashes;
- the GitHub Actions storage and retention binding.

Running the collector without `--require-ok` never creates `release-index.json`. With `--require-ok`, the collector first passes the existing semantic checker and only then creates the small index. A failed or blocked collection therefore cannot manufacture an index.

## Storage and retention

`security/evidence-contracts/release-bundle-storage.json` defines GitHub Actions artifacts as the storage authority. `.github/workflows/release-evidence-storage.yml` is reusable only; defining it does not publish anything by itself. A calling release workflow must supply a workflow-local candidate bundle, its target environment, and the manifest-derived `release_id` / `created_at_utc` / `commit_sha` / `image_digest` tuple. The storage workflow cross-validates the canonical release identity, reruns `--require-ok`, seals the bundle, and uploads `fsusblog-release-evidence-{releaseId}` with `overwrite: false` and 90-day retention.

The contract records normal expiry, legal/audit holds and rollback-reference retention. An active or supported rollback target remains referenced until its support window ends. A hold suspends ordinary expiry and must be recorded by the repository owner. Deletion does not make a tracked index authoritative: any consumer must fetch the referenced bundle and recompute the manifest and artifact-set digests.

The optional index contains only release ID, commit SHA, image digest, bundle digest, storage reference, collected status, generation time and retention days. Full bundles and indexes remain untracked by default.

## Local governance checks

```bash
node tools/operations/check-release-evidence-layout.mjs
node --test tests/tools/release-evidence-model.test.mjs
node --test tests/tools/release-document-convergence.test.mjs
node tools/operations/check-release-evidence-manifest.mjs --self-test
```

These commands are local/static checks. They do not execute production validation, upload artifacts or publish a release.
