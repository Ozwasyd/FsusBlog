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

The original rollout shell owner may write separate `fsusblog.release-rollout-shell-preparation.v1` and `fsusblog.release-rollout-shell-result.v1` diagnostic records around its fixed, argument-free stage function. Preparation binds the active rollout/stage/attempt, source and target, immutable manifest bytes, owner-script bytes, and an actual monotonic start sample. A result references those complete preparation bytes and the already-owned stdout/stderr artifacts by whole-file digest, records the actual shell exit and monotonic completion sample, and never embeds log contents or credentials. Collection uses fixed-size reads: preparation is limited to 64 KiB, owner and manifest to 1 MiB each, and each raw output to 64 MiB; an oversized or changing input fails collection rather than becoming truncated evidence. A collection failure does not replace an earlier command failure. A missing or interrupted command return cannot be converted into a terminal diagnostic by assigning exit 130.

These records remain `diagnostic-only`: a shell return, script digest, or `commandId` is not proof of native verification, immutable execution, scheduler admission, descendant termination, or cleanup. They do not change the rollout stage-evidence v2 schema or authorize the current-schema receipt. A full native admission collector must separately bind the original admitted execution, candidate/source/run/attempt/runtime identities and compiled native-owner configuration before spawning, then consume the actual native terminal result. Its versioned stage protocol, original replay consumer, resume handling and final verification must change together; diagnostic records cannot stand in for that protocol.

Release Reliability scenarios use the v4 structured catalog and one physical executor. The catalog fixes the seven canonical IDs, explicit exclusive/countable conflict resources, structured lifecycle action references, outputs and tool identities without changing scenario thresholds or commands. The referenced `fsusblog.release-reliability-lifecycle-action-registry.v1` is the only authority for all 35 actions: executable/arguments/environment/cwd, action timeout, expected receipt path/schema, pass status, state domains and whether a reset-after action is safe after failure. Tree termination grace, force deadline, bounded pipe close and stable empty observation come only from `config/testing/physical-execution-process-policy.json`; they do not override action timeout. The action registry schema and closed-world runtime state-domain registry reject unknown operations, phases, paths, domains or duplicate/missing action ownership.

For each scenario the executor runs `preconditions`, `resetsBefore`, `measurement`, `postconditions` and `resetsAfter` in that order as real child processes through the same process-tree runner. Linux establishes a transient user-systemd cgroup plus a run-owned process group, macOS uses an independent process group, and Windows assigns a suspended child to a kill-on-close Job Object before resume; unavailable correctness authority fails before the business child. SIGINT, SIGTERM, SIGHUP, AbortSignal and action timeout freeze one cancellation reason, stop later primary spawn, then perform TERM, policy grace, KILL, bounded pipe close and consecutive zero-member observation. The first non-cleanup failure is frozen in `firstFailure` and cannot be replaced by cleanup failure; only registry actions explicitly marked `safeAfterFailure` may run afterward, with failures retained in `cleanupFailures`.

The outer executor writes exactly one sealed `fsusblog.release-reliability-process-tree-receipt.v1` per executed action under the invocation process-tree root. It binds run/action/command identity, physical-policy bytes, PGID/cgroup/Job authority, process start identities and inventory, termination phases, log completeness and terminal fence. The lifecycle child never rewrites that receipt. A reset-after action that owns `runtime.measurement-children` receives the measurement receipt only by explicit path, validates the raw bytes, run/action/policy binding and `postObservation=zero-members`, then stores a minimal `measurementDescendants` binding in its existing lifecycle receipt. The independent lifecycle verifier rereads the raw process-tree receipt rather than trusting `status: zero`. Missing, cross-run, changed, non-zero, partial-log or otherwise unverifiable bindings fail.

Shared runtime actions exact-match the bound backend/PostgreSQL/Redis IDs, network membership, base URL, namespace, run and relevant resource counters before and after measurement. Mutation reset-after removes only `.tmp/mutation/backend-critical`, observes the absence of mutation output and preserves the immutable production build. Data-scale does not seed or clean shared qualified-local services: its precondition consumes the explicit dedicated runtime authority, binds that owner document's raw path/bytes/content digest and exact PostgreSQL/Redis/backend/root identities, and derives the measurement environment only from those verified fields. Its reset-after consumes an explicit teardown authority for the same `dataScaleRunId` and requires zero remaining resources, ports, leases and roots. Missing dedicated runtime, teardown or zero-descendant process-tree owner evidence remains failed rather than being synthesized by the adapter.

The v4 catalog remains the exact qualification and child-environment contract. It fixes the 300-second short soak, both load profiles, scale-m seed/request shape, resource request/concurrency and delta limits, the mutation subset, required/optional inherited keys, fixed non-secret values and executor-owned internal keys. The executor never spreads the caller environment: missing required inherited keys fail before spawn, while undeclared `FSUSBLOG_*`, `NODE_OPTIONS`, .NET tuning and secret-bearing values do not reach the producer or sealed result. Each result records only fixed values and a content digest of its environment contract. The run identity content-addresses that complete contract plus the actual scenario catalog, lifecycle action registry, state-domain registry, physical-execution, load-profile, mutation-subset and release-resource policy bytes.

Load, soak, scale and resource authorities record their effective non-secret sampling and threshold values. After Release mutation parity succeeds, the mutation lane atomically records the subset policy digest, run-bound parity receipt digest and exact planned/executed mutant IDs in `releaseQualification`. These fields are producer authority, not executor patch-up.

The complete entry writes one sealed run identity, seven sealed `fsusblog.release-reliability-scenario-result.v3` files, one sealed `fsusblog.release-reliability-timeline.v3` and one `candidate-receipt.json`; the scenario generator cannot write a qualified status. Every action reference binds both its registry-owned raw receipt and its executor-owned process-tree receipt; the result/timeline chain retains both raw bytes digests and the closed terminal fence. Cancellation or timeout removes the action receipt from eligibility and never reads a later write, even if a producer subsequently writes `passed`. A correctness result is qualification-eligible only when the requested evidence class is correctness and its complete lifecycle passed. An invocation with `--scenario` instead declares `evidenceClass=diagnostic` and `qualificationEligible=false`, invalidates any qualification output under the same invocation, and never writes a candidate or qualified receipt. The receipt producer and independent verifier both reject diagnostic or implicitly classified results, so seven separately passed diagnostics cannot be aggregated into release evidence.

While the verified runtime is still alive, the independent verifier rereads every live and persistent authority and writes one content-addressed `verified-attestation.json`. The wrapper then removes its owned runtime containers before asking the verifier to finalize `fsusblog.release-reliability-qualified-receipt.v3`. That terminal receipt binds the candidate bytes, verified attestation bytes and the attestation's exact persistent-file manifest. Later terminal verification needs no live container: it rederives the required manifest from the candidate, rereads every bound result, original producer evidence, lifecycle/build/fixture/topology/policy file and verifier source, and rejects missing, extra or changed bytes. A candidate without an attestation, a cross-run attestation, a self-recomputed digest, or any post-attestation tamper cannot finalize. The aggregate contains only the exact scenario result path/content digest and original producer evidence path/bytes digest; it does not copy source or lifecycle payloads. Qualification requires the canonical seven references from one invocation and run, a canonical byte/mode/index-aware Git worktree fingerprint, parsed source/run-bound production build receipt and a concrete image digest matching runtime topology, repository-confined fixture config/schema/seed/topology files, the canonical `AuditRetentionCatalog` policy bytes required by startup readiness, actual declared tool versions, complete machine/cgroup limits, scheduler resource policy and catalog/threshold bytes. Missing, duplicate, extra, cross-run, cross-source, tampered, cancelled, partial, failed, collector-unavailable or lifecycle-incomplete input stays failed.

The local producer must first create or consume the existing immutable production-build authority, then supply its root through `FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT` (and, when transferred, `FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST`). Before the producer starts, the qualified-local wrapper obtains its complete run-bound build environment only from `resolveProductionBuildLayout` and `productionBuildEnvironment`; a fixed allowlist is emitted as NUL-delimited assignments and imported without `source` or `eval`. The same exported environment remains in the wrapper for final-image and bootstrap consumers, while unrelated caller variables (including local FsusUI inputs) remain inherited. The collector calls `verifyProductionBuildReceipt` with the current source, run, `production-build-artifacts` producer identity, current toolchain and checkout inputs; it rejects `FSUSBLOG_RELEASE_BUILD_RECEIPT`. It also requires `FSUSBLOG_RELEASE_RUNTIME_IMAGE`: both registry and local images must expose `org.opencontainers.image.revision` equal to the full FsusBlog source commit plus explicit `io.fsusblog.build.fsusui-source` and 40-character `io.fsusblog.build.fsusui-commit` labels. Those values are sealed in build identity and independently re-inspected; missing, cross-source or drifted labels fail closed. A registry image additionally records its concrete `RepoDigest`, while `build-final-image.sh` local-only output records its inspected local Docker config digest and non-empty RootFS layer digest list as `local-docker-image-id`. `FSUSBLOG_RELEASE_IMAGE_DIGEST` is rejected. The qualified-local wrapper parses the generated namespace environment with the repository runtime-environment parser; it never sources that file as shell. It creates one run-owned bridge, attaches the owned PostgreSQL and Redis containers through the unique `postgres` and `redis` aliases, and maps the final backend's internal port 8080 only to the parsed dynamic loopback port. The backend environment is the strict namespace file plus the audited container-local bind, host, connection, storage, diagnostic and run-identity overrides. Before collection, Docker must report the immutable image healthcheck unchanged on the container and `healthy`; the wrapper then requires HTTP 200 JSON `live` plus a byte-valid `SeoConfig` AEDS v2 frame within a separate 60-second smoke window, which intentionally does not claim full readiness. The runtime topology seals that health configuration and digest, bridge membership and aliases, port mapping, environment projection, Docker container ID and host PID. The executor passes only the container/PID pair to the soak, memory and open-handle producers, which re-inspect the live pair and read the backend's `/proc/1` RSS/FD metrics through that exact container namespace; resource identity is not rediscovered from a port or log, and host `/proc` permission differences do not turn a live metric into a synthetic value. The exit trap stops the bound process group, removes the concrete backend/PostgreSQL/Redis container IDs, then removes only the label-matching run-owned network. This intentionally makes an unavailable build verifier, image inspector, canonical audit policy, native healthcheck, runtime smoke canary or owned cleanup an unqualified run, rather than accepting a hand-written receipt, digest or health bypass.

Immediately before the executor, qualified-local creates a second positive allowlist and launches it through `env -i`. On Linux, the base carrier includes `XDG_RUNTIME_DIR` only after proving it is the current user's exact `/run/user/<uid>` non-symlink directory with owner `<uid>`, mode `0700` and a `bus` socket; `DBUS_SESSION_BUS_ADDRESS` and other ambient bus settings never cross the boundary. The remaining entries are only base process keys and the run/build/fixture/source bindings needed for identity collection, so ambient soak/load/resource/scale/mutation semantics cannot enter it. The runtime-environment parser may supply approved topology fields to the executor, but producer children still receive only their scenario-specific positive contract.

`tools/test/verify-release-reliability-receipt.mjs` is independent of generator success logic. Its live attestation phase resolves exact declared paths under one approved canonical root, rejects traversal and symlinks, rereads and hashes the actual result, producer evidence, lifecycle, build, fixture, topology and policy files, recomputes the current worktree snapshot and tool/cgroup identity, and validates exact schemas, statuses, UTC times, run/invocation equality and sealed references. Finalization accepts only that verifier-produced attestation after owned runtime cleanup; normal `--receipt` verification then uses the attested exact persistent manifest and does not consult Docker or another live service. Neither phase discovers authority by URL, mtime, age or “latest” selection. Validate a finalized receipt with `node tools/test/verify-release-reliability-receipt.mjs --receipt <path>`; `--root <approved-root>` exists for an explicitly selected local repository root.

`release-final` consumes that terminal authority through one exact-one locator,
not through the seven scenario summaries. The locator scans only canonical
`.tmp/release-reliability/*/qualified-receipt.json`: zero matches report
`./tools/test.sh ci-tier release-reliability-fresh` without spawning a producer,
and multiple matches report every sorted path as ambiguous. It never selects by
mtime, age, “latest” or first match. For the one match it first runs the
independent terminal verifier above, then emits exactly seven top-level audit
fields: `authorityId`, `receiptPath`, `contentDigest`, `sourceIdentity`,
`buildIdentity`, `scenarioIds` and `verificationStatus`. The nested binding
preserves source/worktree, production-build, image, fixture, machine, topology,
catalog/threshold/policy and all seven result/original-evidence digests. Job
summaries remain transport and completeness records only; memory and open-handle
metrics can affect correctness only through the verified scenario evidence
references. Downloaded `release-reliability` artifacts are restored into the same
canonical `.tmp/release-reliability/` tree before finalization.

The verifier independently rederives the environment contract and checks effective soak duration, load declared/effective/sampling/threshold values, scale-m tier and seed shape, resource sampling and delta thresholds, and mutation subset/parity/planned/executed bindings. Recomputed evidence digests cannot legitimize weakened sampling, loosened thresholds, substituted policies or a different mutation subset. The attested persistent manifest includes all qualification policy files and the run-bound mutation parity receipt.

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

After the theme runtime is present, release collection also requires the fresh
`.tmp/release-evidence/theme-css-safety-summary.json` produced by scanning the
release candidate theme. The collector runs
`tools/release/theme-css-safety-evidence.mjs` before copying it, and
`release-final` revalidates the copied artifact. Missing, blocked, malformed,
symlinked or over-budget evidence keeps collection blocked. See
[Theme CSS safety and asset budgets](themes/css-safety.md).

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
