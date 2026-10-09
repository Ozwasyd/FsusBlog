## Linked Issue

Refs #3612

Related to [#3536](https://github.com/Ozwasyd/FsusBlog/issues/3536) and [#3533](https://github.com/Ozwasyd/FsusBlog/issues/3533). **WIP draft; no issue is accepted or closed.**

## Scope Summary

- Current WIP source: retain the canonical minimal OpenAPI receipt and scoped four-field scanner owners; consume canonical literal rendering, typed route census, two comment bounds and the release bundle-order product. The final release change is one generated line containing four escaped arrows. Exterior prose, markers and the adjacent deployment region are preserved.
- Exact remote head: `bfca0bd79319554b9f61b06d4b30af5726179cc3`; source branch: `codex/chain-3612-release-review-current`; target: `master`, observed at `537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`. Review merge-base: `aaba7b8c84ecfb336c71443e30d9fd82d21fb16d`. [Complete 29-path comparison](https://github.com/Ozwasyd/FsusBlog/compare/aaba7b8c84ecfb336c71443e30d9fd82d21fb16d...bfca0bd79319554b9f61b06d4b30af5726179cc3).
- Inherited prerequisites are part of this complete scope: canonical observer lock/replay and minimal receipt owners, matrix extractor/fixture and generated authority, scoped four-field scanner and regressions, plus current generated documentation. No prerequisite source is omitted from the review merely because it predates the latest increment.

Complete changed-path scope:

- `config/testing/release-final-execution-authority-index.json`
- `docs/api.md`
- `docs/api/aeds-only-policy.md`
- `docs/api/quick-reference.md`
- `docs/api/schemas-and-errors.md`
- `docs/api/stability.md`
- `docs/architecture/comment-command-boundary.md`
- `docs/architecture/comment-query-boundary.md`
- `docs/architecture/monolithic-distributed-boundary.md`
- `docs/architecture/overview.md`
- `docs/releases/blue-green-deployment-runbook.md`
- `docs/releases/release-identity.md`
- `docs/testing.md`
- `tests/fixtures/test-matrix/release-final-execution-target-authority.json`
- `tests/tools/behavior-document-consistency-final.test.mjs`
- `tests/tools/generated-fact-sections.test.mjs`
- `tests/tools/native-tooling-style.test.mjs`
- `tests/tools/openapi-aeds-observation.test.mjs`
- `tests/tools/release-final-static-boundary.test.mjs`
- `tests/tools/support/zero-legacy-scanner-fixture.mjs`
- `tests/tools/test-matrix-topology-observation.test.mjs`
- `tools/contracts/FsusBlog.AuthSessionObservation/packages.lock.json`
- `tools/contracts/FsusBlog.ConfigErrorSecurityObservation/packages.lock.json`
- `tools/contracts/FsusBlog.ContentLifecycleObservation/packages.lock.json`
- `tools/contracts/FsusBlog.OpenApiObservation/packages.lock.json`
- `tools/contracts/FsusBlog.RuntimeRoleObservation/packages.lock.json`
- `tools/docs/behavior-document-consistency-final.mjs`
- `tools/docs/generated-fact-sections/renderers.mjs`
- `tools/fact-extractors/test-matrix/extract.mjs`

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [x] Generated output
- [ ] Public contract change
- [x] External naming exception
- Contract impact: none

## Tests Run

- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests:
- [ ] Targeted frontend checks:
- [x] Other: PASS on bfca0bd79319554b9f61b06d4b30af5726179cc3: original SDK 10.0.302 minimal producer, five genuine compiled hosts, cache miss; all eight original uncached fact extractors return ok. Minimal receipt content digest: 1b84431ce37dbff0cdcec6b44df053c52d8570c1b7b838903bc549ec6d6ee264.
- [x] Other: PASS on bfca0bd79319554b9f61b06d4b30af5726179cc3: original generated CLI checks 34 documents and 84 sections; original prose CLI verifies 37 prose claims from 121 located claims, with zero diagnostics. All three previously blocked bodies match current canonical rendering. Compiled OpenAPI observes 274 operation-status-authority-bound operations. Bytes, sizes and mtimes of all 34 documents remain unchanged.
- [x] Other: PASS on bfca0bd79319554b9f61b06d4b30af5726179cc3: full commit-range and whitespace checks. Lifecycle 372, DocClaim 121 and prose-governance checks passed on 29cd0b3d734511bda329148cb3712dea9238f71f; identical tree c87b777ae82077d67acb0dfbc920567cafe8b553 establishes source-input continuity, not receipt rebinding.
- [x] Other: FAIL on 29cd0b3d734511bda329148cb3712dea9238f71f, whose tree is identical to this head: three-document Markdownlint exits 1 for two inherited MD022 headings. Full admission, held rejection/mutation controls, matrix/full CI, independent review and current-master qualification are UNRUN on this head.
- [ ] Other: Remote required checks, trusted-base complete PR metadata validation and current-master qualification are unresolved; missing checks are not passes.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

## Coding Convention

- [x] C# mother-style mapping checked
- [x] Formatter/linter run
- [x] No tool default overrides repository style
- [ ] Mechanical formatting separated from logic
- [x] `.git-blame-ignore-revs` updated when applicable
- Formatter identity: none
- Formatter version: none
- Formatter command: none
- Formatter idempotence evidence: none
- Blame-ignore revision: none

## External Naming Exception

- Exceptions manifest: unresolved

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [ ] TODO/FIXME references valid issues

## Compatibility And Risk

- [x] [Cross-language coding conventions](../docs/development/coding-conventions.md) reviewed
- [x] Document lifecycle updated: stable facts are current; issue handoffs are historical/proposed; generated docs identify their producer
- [x] External wire / ABI / database / third-party names preserved or explicitly adapted
- [x] Public API impact reviewed
- [x] AEDS frame / binary contract impact reviewed
- [x] Database migration impact reviewed
- [x] Security, auth, moderation, PoW, or privacy impact reviewed
- [x] Docs updated or a reason is recorded below
- [x] Known limitations updated if applicable

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: no measured performance, product runtime, native, release or whole-CI qualification claim

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: align current BehaviorDoc facts and prose

## Generated Output

- Generator source: tools/docs/generate-fact-sections.mjs, config/contracts/behavior-fact-extractors.json, config/contracts/generated-fact-sections.json, tools/fact-extractors/runner.mjs, tools/fact-extractors/test-matrix/extract.mjs, tools/test-matrix/generate-release-final-execution-authority.mjs, tools/docs/generated-fact-sections/generator.mjs, tools/docs/generated-fact-sections/renderers.mjs
- Generated outputs: config/testing/release-final-execution-authority-index.json, docs/api.md, docs/api/aeds-only-policy.md, docs/api/quick-reference.md, docs/api/schemas-and-errors.md, docs/api/stability.md, docs/architecture/comment-command-boundary.md, docs/architecture/comment-query-boundary.md, docs/architecture/monolithic-distributed-boundary.md, docs/architecture/overview.md, docs/releases/blue-green-deployment-runbook.md, docs/releases/release-identity.md, docs/testing.md, tests/fixtures/test-matrix/release-final-execution-target-authority.json
- Digest/evidence: unresolved
- Automation identity: none

## Rollout / Rollback

- Rollout: publish this WIP draft for review immediately; retain the exact source ref and evidence identities. No merge, deployment, issue closure, trusted-policy promotion or cross-branch conflict resolution is authorized.
- Rollback: retain the predecessor refs and receipts; any later correction is separately reviewed. Do not rewrite published history or rebind old receipts to a new SHA.
- Deferred work: accepted prerequisite evidence, original rejection/mutation controls, full integrated admission/matrix/CI, formal style, generated/naming metadata, independent review and current-master acceptance.
- Known limitations: the result of one SHA does not qualify another. Physical preparation/recovery obligations remain unresolved, with no successful native descriptor or zero-residue claim. Generated-binding and exact external-naming manifests are unresolved; this draft is not claimed green under Change Contract. Mechanical-separation and complete TODO/FIXME review are also unresolved.

## Notes For Reviewers

Ownership and prerequisites: this review covers [#3612](https://github.com/Ozwasyd/FsusBlog/issues/3612), [#3536](https://github.com/Ozwasyd/FsusBlog/issues/3536) and [#3533](https://github.com/Ozwasyd/FsusBlog/issues/3533). The original canonical owners remain [#3537](https://github.com/Ozwasyd/FsusBlog/issues/3537), [#3540](https://github.com/Ozwasyd/FsusBlog/issues/3540), [#3534](https://github.com/Ozwasyd/FsusBlog/issues/3534), [#3610](https://github.com/Ozwasyd/FsusBlog/issues/3610) and [#3611](https://github.com/Ozwasyd/FsusBlog/issues/3611). Comment and release products come from [#3576](https://github.com/Ozwasyd/FsusBlog/issues/3576) and [#2225](https://github.com/Ozwasyd/FsusBlog/issues/2225) when included in this head. Their independent acceptance is not inferred from source availability.

Applicable acceptance remains: compile and verify the exact public-error prose state; validate canonical minimal and separate OpenAPI receipt paths with all original stale/source/run/artifact/projection refusals; preserve all four qualification-only field rules and non-qualification behavior without a DocClaim waiver; run original generated/prose/mutation, lifecycle, matrix/static and change-contract gates; obtain independent review and later current-master acceptance. All three issues remain WIP.

Review checkbox applicability: this diff changes JavaScript governance, tests, lockfiles and generated Markdown/JSON, not C# product code, user-visible UI, wire/ABI, database execution or security policy. C# mapping and UI/database/security/ABI items record this scope review, not runtime acceptance. UI evidence is not applicable. No format-only or performance claim is made, so formatter/idempotence/blame/performance fields are `none`. The linter-run checkbox records the executions above, including failures. No default policy was overridden. The exact registered naming-surface coverage and a valid changed generated-binding manifest still require their owners; no diagnostic summary is substituted for those schemas.

Next commands: after draft creation, inspect `gh pr view <number> --repo Ozwasyd/FsusBlog --json headRefOid,baseRefOid,labels,statusCheckRollup,reviewDecision` and reconcile the public metadata with the exact submitted SHA. Pending original acceptance in a qualified environment, the original commands are `node tools/docs/behavior-doc-static-admission.mjs --run-id <fresh-current-source-run>`, `node tools/run-test-matrix.mjs validate`, and `./tools/test.sh fast`. These commands have not been rerun for this handoff. Native, adversarial-control, matrix and whole-CI qualification remain UNRUN where noted above.

[Public candidate binding proof](https://github.com/Ozwasyd/FsusBlog/blob/60051d8376e42580758c92b386e1e0081ca19f57/artifacts/governance/chain-3612-release-owner-handoff/current-product-proof.json) belongs to `bfca0bd79319554b9f61b06d4b30af5726179cc3` only; it is not a pass for another branch or for the evidence-only commit that stores it. Two inherited comment-document MD022 errors were introduced by [db1c168a7a29e1e9f5c7d98f606a1e33110340eb](https://github.com/Ozwasyd/FsusBlog/commit/db1c168a7a29e1e9f5c7d98f606a1e33110340eb), related to [#1756](https://github.com/Ozwasyd/FsusBlog/issues/1756). They remain with their original authored-prose owner; this review neither edits nor waives them.
