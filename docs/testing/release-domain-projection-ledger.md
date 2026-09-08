# Release domain projection ledger

`config/testing/release-domain-assertion-dispositions.json` replaces every historical release assertion exactly once. It records disposition, canonical producer, required test and artifact IDs, native structured-evidence selectors, exact logical output receipt, replacement proof, and explicit target-only/obsolete state. Each domain catalog must match its ledger exactly. The [Evidence Projection Contract](evidence-projection-contract.md) defines the shared receipt boundary.

After a canonical producer finishes, `write-release-domain-assertion-report.mjs` only parses its existing Vitest JSON, live-grant execution report, browser-diagnostics release-runtime receipt, or immutable artifact report. It never starts a test, build, browser, runtime, or fallback command. The sealed `fsusblog.release-domain-assertion-report.v1` binds every assertion to its exact producer selector and native source-artifact SHA-256. Receipt construction and final projection both reopen those source artifacts and revalidate their current-run identity, exact assertion/probe IDs, nested execution IDs, outcomes, build identity, and policy identity. Plain logs and self-asserted `Passed` fields cannot become receipts.

The release-runtime diagnostics producer preserves the historical script assertions without treating a generic Browser Contract scenario as equivalent evidence. `release-rbac-negative` all-of binds `check:security:permissions` and `check:security:attack-matrix`; `release-aot-consumption` all-of binds `check:pow-runtime`, `check:public-hydration`, and `check:distribution-version-coherence`. Each probe writes a sealed subassertion artifact, and the diagnostics receipt binds the exact probe ID, all expected subassertion IDs, source/worktree, diagnostics and scheduler run, immutable build digest, policy digest, and copied artifact path. Either the full probe set or any selected subassertion being missing, extra, failed, duplicated, stale, or modified invalidates both logical domains.

`release-final` consumes only the seven projection receipts that are also canonical
release-final evidence inputs: admin console, AOT generation, auth flow, authoring
flow, error boundary, private preview, and static asset digest coherence. It does not
search for producer receipts, assertion reports, native test output, or a fallback
command. The collector requires exactly one receipt at every ledger-declared output
path, validates its sealed source/run/namespace/build/policy binding and zero-spawn
boundary, then records the exact path plus file, content, build, and policy digests in
the final binding. Deleting, replacing, duplicating, adding, relocating, or modifying
one of these seven bindings fails closed even if the edited final document is
re-sealed. The RBAC-negative and AOT-consumption diagnostics remain independent
logical projections and are not silently promoted into the canonical release-final
set.

| Logical domain | Historical assertion disposition | Canonical producer | Catalog | Receipt |
| --- | --- | --- | --- | --- |
| admin console | Production Fresh canonical projection | `frontend-unit-shard` | `release-admin-console.json` | `.tmp/release-evidence/projections/release-admin-console.json` |
| auth flow | Production Fresh canonical projection | `frontend-unit-shard` | `release-auth-flow.json` | `.tmp/release-evidence/projections/release-auth-flow.json` |
| authoring flow | Static/governance producer projection | `test-quality-lint` | `release-authoring-flow.json` | `.tmp/release-evidence/projections/release-authoring-flow.json` |
| private preview | Static/governance producer projection | `test-quality-lint` | `release-private-preview.json` | `.tmp/release-evidence/projections/release-private-preview.json` |
| error boundary | Static/governance producer projection | `test-quality-lint` | `release-error-boundary.json` | `.tmp/release-evidence/projections/release-error-boundary.json` |
| RBAC negative | Browser diagnostics release-runtime projection | `browser-diagnostics-manual` | `release-rbac-negative.json` | `.tmp/release-evidence/projections/release-rbac-negative.json` |
| AOT generation | Immutable build/artifact projection | `release-evidence` | `release-aot-generation.json` | `.tmp/release-evidence/projections/release-aot-generation.json` |
| AOT consumption | Browser diagnostics release-runtime projection | `browser-diagnostics-manual` | `release-aot-consumption.json` | `.tmp/release-evidence/projections/release-aot-consumption.json` |
| static asset digest coherence | Immutable build/artifact projection | `release-evidence` | `release-static-asset-digest-coherence.json` | `.tmp/release-evidence/projections/release-static-asset-digest-coherence.json` |

`release-closeout` remains the sole target-environment closeout authority. None of the migrated historical assertions is target-only or obsolete, so all 24 entries map to one of the four canonical projection classes above. Missing, duplicate, failed, cancelled, cross-identity, ambiguous, or modified producer evidence fails closed.
