## Linked Issue

Refs #3593

## Scope Summary

- **WIP — DRAFT. Issue acceptance remains open.** Integrate the canonical SOURCE blame-ignore capability while preserving the suite-convergence mechanical migration. Retain current fs/path imports and repository-root routing, consume the exact finite-parser registration, and regenerate execution authority through its unchanged original producer.
- Head branch: `task/3593-leaf-source-port`; exact remote head: `0a6dc39f7b2c3a5527d020ff855973ac27bb1226`.
- PR target: `master`, observed target SHA `537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`. Actual comparison merge base: `be7c53d99b64342925ca63d061bacde34d22ba4c`. Results below retain their original tested SHA; current-master gates are UNRUN.
- Issue owner: [#3593](https://github.com/Ozwasyd/FsusBlog/issues/3593), prerequisite to [#3543](https://github.com/Ozwasyd/FsusBlog/issues/3543). Canonical source/metadata owners remain [#3659](https://github.com/Ozwasyd/FsusBlog/issues/3659), [#3534](https://github.com/Ozwasyd/FsusBlog/issues/3534), and [#3521](https://github.com/Ozwasyd/FsusBlog/issues/3521); catalog historical qualification remains with [#3520](https://github.com/Ozwasyd/FsusBlog/issues/3520)/[#3521](https://github.com/Ozwasyd/FsusBlog/issues/3521). No sibling-owned implementation is added by this handoff. Canonical roster increment: [fae117436a4c829748c04c6381d86db6be764e76](https://github.com/Ozwasyd/FsusBlog/commit/fae117436a4c829748c04c6381d86db6be764e76); subsequent ordinary source [40d9774b3bab7e21b845984eff7e963d5c832c52](https://github.com/Ozwasyd/FsusBlog/commit/40d9774b3bab7e21b845984eff7e963d5c832c52) is present in the active continuation and reviewed boundary, not inferred for earlier snapshots. Exact consumed SOURCE port [0a88beb347d1941d140898cfa39c49285841e2d5](https://github.com/Ozwasyd/FsusBlog/commit/0a88beb347d1941d140898cfa39c49285841e2d5), replay [462d0f872a791764255e8d342d4268a70417ee05](https://github.com/Ozwasyd/FsusBlog/commit/462d0f872a791764255e8d342d4268a70417ee05); exact finite-parser source [5e01897f5bed3a31d17b87d65b15a653cd8f1517](https://github.com/Ozwasyd/FsusBlog/commit/5e01897f5bed3a31d17b87d65b15a653cd8f1517), related [PR #3934](https://github.com/Ozwasyd/FsusBlog/pull/3934). Supplier test receipts are not copied as this candidate results.

Complete changed-path scope, including all inherited prerequisites and evidence (16 paths, `git diff --name-status master...head`):

- `M .git-blame-ignore-revs`
- `A artifacts/change-contract/correctness-current-migration-execution-binding.json`
- `A artifacts/change-contract/suite-convergence-leaf-external-naming.json`
- `A artifacts/style/suite-convergence-leaf-idempotence.json`
- `M config/testing/correctness-attempt-producers.json`
- `M config/testing/release-final-execution-authority-index.json`
- `M tests/fixtures/test-matrix/release-final-execution-target-authority.json`
- `A tests/tools/blame-ignore-source.test.mjs`
- `M tests/tools/correctness-attempt-migration.test.mjs`
- `M tests/tools/pr-impact-plan.test.mjs`
- `M tests/tools/release-final-static-boundary.test.mjs`
- `M tests/tools/test-suite-convergence.test.mjs`
- `A tools/test-matrix/blame-ignore-source.mjs`
- `M tools/test-matrix/pr-impact-plan.mjs`
- `M tools/test-matrix/source-governance.mjs`
- `M tools/test/correctness-attempt-migration.mjs`

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [x] Generated output
- [ ] Public contract change
- [x] External naming exception
- Contract impact: none

The aggregate contains separate preserved mechanical/syntax commits, so the PR aggregate is not classified as format-only. The SOURCE port adds tooling behavior only in the active integration branch.

## Tests Run

- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests:
- [x] Targeted frontend checks: recorded owner style PASS at `0a6dc39f7b2c3a5527d020ff855973ac27bb1226`; no test rerun for this handoff.
- [x] Other: recorded checks below, each bound to its stated SHA; [SHA-bound verification evidence](https://github.com/Ozwasyd/FsusBlog/blob/25031cbfeb83982641299fcbe03fba067db9eefe/artifacts/style/suite-convergence-integrated-source.json).

PASS at `0a6dc39f7b2c3a5527d020ff855973ac27bb1226`: 7 canonical controls and 6 SOURCE routing controls, 13 passed / 0 failed / 0 skipped; strict leaf style; all 9 changed JavaScript source-diff checks; complete original static-boundary reader; canonical catalog check; trusted commit range; original local prepared PR/blame metadata; AST 17+2 identities; two actual formatter passes. Original producer ran twice at `462d0f872a791764255e8d342d4268a70417ee05` before the output/metadata commit, producing identical 1139 closure files and 102 preserved target identities.

FAIL at `0a6dc39f7b2c3a5527d020ff855973ac27bb1226`: original suite-convergence checker exits 1 for exactly the two unchanged backend-QPS replacement declarations absent from the compact BEFORE snapshot.

UNRUN: full SOURCE and Git-replacement/receipt/cohort/lease/native audits; compiled/PG/runtime/full CI; actual GitHub PR gate; independent complete-16-path acceptance; any verification against current master `537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

No observable UI source is changed in this comparison; these items are not applicable.

## Coding Convention

- [x] C# mother-style mapping checked
- [x] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [x] `.git-blame-ignore-revs` updated when applicable

- Formatter identity: none
- Formatter version: none
- Formatter command: none
- Formatter idempotence evidence: none
- Blame-ignore revision: none

Aggregate fields above are not applicable to a non-format-only PR. The original mechanical commit `e8def31887dab241d74ad712226290f715ace23d`, later blame commit `27a09aa6223ca61922c08e96fb1d1760e912c163`, and `artifacts/style/suite-convergence-leaf-idempotence.json` remain in the actual history. Recorded formatter/AST results do not grant whole-candidate acceptance.

## External Naming Exception

- Exceptions manifest: artifacts/change-contract/suite-convergence-leaf-external-naming.json

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

No public API or maintained documentation behavior changes require new API documentation. This issue handoff is historical WIP evidence, not a new source of policy. Ownership and unresolved requirements are recorded here; no policy, baseline debt, oracle or frozen BEFORE is weakened.

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

These checked items record applicability review: this comparison changes test/tooling/metadata surfaces, not C#, product API, AEDS, database schema or production auth. They do not claim runtime, migration, security or UI acceptance. Existing external names and original test identities remain protected by their original gates.

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: runtime qualification, performance claims and trusted policy promotion

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: integrate exact suite convergence source boundary

## Generated Output

- Generator source: tools/test/correctness-attempt-migration.mjs, config/testing/release-final-execution-authority-index.json, tests/tools/blame-ignore-source.test.mjs, tests/tools/pr-impact-plan.test.mjs, tools/test-matrix/blame-ignore-source.mjs, tools/test-matrix/pr-impact-plan.mjs, tools/test-matrix/source-governance.mjs
- Generated outputs: tests/fixtures/test-matrix/release-final-execution-target-authority.json
- Digest/evidence: artifacts/change-contract/correctness-current-migration-execution-binding.json
- Automation identity: none

Ordinary execution-output metadata, where present, does not establish separate catalog current-epoch historical qualification.

## Rollout / Rollback

- Rollout: create as DRAFT/WIP immediately for inspection; no merge, deployment, issue closure or downstream acceptance.
- Rollback: use ordinary reviewed revert commits for source increments; retain historical proof and mechanically valid blame history. Do not rewrite either frozen source head or canonical owner branches.
- Deferred work: current-master rebinding, applicable original complete source/retention/generated/matrix gates, catalog/QPS historical authority, independent review and compiled/PG/runtime/full CI.
- Known limitations: PASS/FAIL counts apply only to the stated tested SHA; current remote-head/current-master results, unknown metadata and unexecuted gates remain UNRUN or unresolved as stated.

## Notes For Reviewers

Remaining #3593 acceptance: bind current source/policy/baseline diagnostics; preserve AST, tokens, anchored comments, test IDs and behavior; preserve separate format-only/idempotence/later-blame history; use the real import owner boundary without a candidate suppression; pass applicable source, retention, generated and impacted matrix gates; obtain independent review and current-master PR gate evidence before #3543 acceptance. Current-source freshness and historical catalog/QPS admission are separate requirements.

Ownership: #3593 owns the suite-convergence test-style change. Canonical SOURCE/finite-parser/catalog owners retain their separately linked implementations and acceptance. Independent review and current-master PR gates are required. Overlapping historical snapshots and [existing broad draft #3814](https://github.com/Ozwasyd/FsusBlog/pull/3814) are not independently mergeable; the active source continuation is `task/3593-leaf-source-port` at `0a6dc39f7b2c3a5527d020ff855973ac27bb1226`.

Next permitted read-only commands, in a checkout of this branch:

```bash
git fetch origin master
git rev-parse origin/master
git rev-parse HEAD
git diff --name-status origin/master...HEAD
git diff --check origin/master...HEAD
```

Next acceptance actions: bind any actual PR checks to its real current head/base and review this complete scope; obtain the linked owners' exact historical-authority evidence before dependent qualification. Do not infer results from another branch, rerun excluded Git/receipt/cohort/lease/native suites, substitute a harness, or treat draft creation as issue completion. Gate execution and any required new-base reconciliation remain unresolved rather than self-approved.
