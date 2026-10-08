# Article Vault decision prototype — NON-PRODUCTION

This opt-in console program supplies bounded decision evidence for
[#1871](https://github.com/Ozwasyd/FsusBlog/issues/1871). It constructs synthetic
in-memory observations and calls the existing canonical contracts. It cannot
execute a sync, connect to a server, mount a watcher, write a receipt or update a
base. Production routes, packages and feature flags cannot reach it.

## Run from the repository root

Install .NET SDK **10.0.302**, the inspected repository Dockerfile pin. The local
`global.json` forbids SDK roll-forward. No SDK is downloaded by these scripts.

```bash
bash prototypes/article-vault-1871/run.sh
bash prototypes/article-vault-1871/check-controls.sh
```

`run.sh` validates canonical source/resource/test SHA-256 bindings, builds the
explicit console project, and emits JSON on stdout. Build logs go to stderr.
Build output, CLI state, NuGet packages and control results stay inside the
prototype directory and are ignored by Git. No production project is referenced;
the project links the original finite source files directly. The control host
links the two original manifest/planner test classes without modifying them.

To inspect reproducibility after creating the task-owned output directory:

```bash
mkdir -p prototypes/article-vault-1871/.artifacts
bash prototypes/article-vault-1871/run.sh > prototypes/article-vault-1871/.artifacts/run-one.json
bash prototypes/article-vault-1871/run.sh > prototypes/article-vault-1871/.artifacts/run-two.json
cmp prototypes/article-vault-1871/.artifacts/run-one.json prototypes/article-vault-1871/.artifacts/run-two.json
```

The process returns 1 if an assertion fails, retains that scenario's captured
inputs/outputs and original authority commit, and continues the other scenarios.
Invoking the built console without `--non-production` returns 2. The command is
a separate development entry point, never a runtime feature flag.

## What the result means

The checked-in [scenario report](scenario-report.json) contains original source
bindings, synthetic byte payloads, canonical serialized bytes as base64, decoded
plan summaries, manifest/plan digests and exact rejection reasons. `reportSha256` hashes
the UTF-8 four-space JSON serialization of the nested `report` before insertion
into the envelope, without a trailing newline. No wall clock or machine path is
part of that report digest. Assertion success is not a completed synchronization.

The prototype validates rename identity preservation, independent edits to two
articles, conservative refusal of same-article disjoint edits, overlapping
conflict, BOM/CRLF/trailing-space preservation, finite AssetId/anchor/link/target
codecs, stale permission observation rejection and missing-base refusal.
The disconnected scenario establishes structural isolation; it does not run the
ordinary server authoring product flow.

Asset byte transport is a synthetic memory copy with digest equality. The
canonical `AssetId` codec retains identity; it is not an asset ledger or portable
dependency transport. Markdown link parsing retains route and anchor, not a
portable article binding. The stable target is supplied explicitly by the
synthetic fixture. Embed testing covers the existing target-token codec only.
Full portable asset/link mapping, FsusUI directive parsing, frozen embed
resolution, upload and materialization are explicitly **not executable**.

The Git marker fixture deliberately records a limitation: this frozen planner
offers `PushUpdate` for opaque marker bytes. That plan is **not executable**
without the canonical source-admission gate. No Git process, parser fork or
writer is introduced to hide the gap.

The synthetic dependency/permission digests establish structurally valid test
inputs. They are labeled placeholders and never represent accepted server,
ledger, permission or dependency authority. All Windows/macOS/Linux native
qualification fields remain false.

Read the [decision record](../../docs/architecture/article-vault-1871/local-first-decision.md)
and [evidence limits](../../docs/architecture/article-vault-1871/prototype-evidence.md)
before assessing #1871. Remove these isolated directories to roll back this
deliverable; no production schema, configuration or content rollback is needed.
