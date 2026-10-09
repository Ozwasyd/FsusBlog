## Linked Issue

Refs #3593

## Scope Summary

- **WIP — DRAFT. Issue acceptance remains open.** Preserve the original suite-convergence test-owner mechanical/syntax migration, later blame registration and all inherited before/verification evidence. This historical 113-path snapshot contains two non-artifact paths and 111 evidence/metadata paths. The active continuation is task/3593-leaf-source-port; this snapshot does not create a new implementation or acceptance shortcut.
- Head branch: `task/3593-leaf-current-master`; exact remote head: `3b901b7ebab3c59b4cc145b3645a659bb562f6b0`.
- PR target: `master`, observed target SHA `537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`. Actual comparison merge base: `cb6f4e4a174ac65735707c7e44286352803e742b`. Results below retain their original tested SHA; current-master gates are UNRUN.
- Issue owner: [#3593](https://github.com/Ozwasyd/FsusBlog/issues/3593), prerequisite to [#3543](https://github.com/Ozwasyd/FsusBlog/issues/3543). Canonical source/metadata owners remain [#3659](https://github.com/Ozwasyd/FsusBlog/issues/3659), [#3534](https://github.com/Ozwasyd/FsusBlog/issues/3534), and [#3521](https://github.com/Ozwasyd/FsusBlog/issues/3521); catalog historical qualification remains with [#3520](https://github.com/Ozwasyd/FsusBlog/issues/3520)/[#3521](https://github.com/Ozwasyd/FsusBlog/issues/3521). No sibling-owned implementation is added by this handoff.

Complete changed-path scope, including all inherited prerequisites and evidence (113 paths, `git diff --name-status master...head`):

- `M .git-blame-ignore-revs`
- `A artifacts/style/suite-convergence-leaf-before.json`
- `A artifacts/style/suite-convergence-leaf-before/base-diagnostics.json.gz`
- `A artifacts/style/suite-convergence-leaf-before/base-diagnostics.stderr.gz`
- `A artifacts/style/suite-convergence-leaf-before/base-full-owner.exit.gz`
- `A artifacts/style/suite-convergence-leaf-before/base-full-owner.log.gz`
- `A artifacts/style/suite-convergence-leaf-before/base-original-focused.exit.gz`
- `A artifacts/style/suite-convergence-leaf-before/base-original-focused.log.gz`
- `A artifacts/style/suite-convergence-leaf-before/base-strict-owner.exit.gz`
- `A artifacts/style/suite-convergence-leaf-before/base-strict-owner.log.gz`
- `A artifacts/style/suite-convergence-leaf-before/install-commands.json.gz`
- `A artifacts/style/suite-convergence-leaf-idempotence.json`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/ast-after-request.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/ast-after.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/ast-after.stderr.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/ast-before-request.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/ast-before.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/ast-before.stderr.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-diagnostics.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-diagnostics.stderr.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-full-owner.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-full-owner.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-matrix-convergence.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-matrix-convergence.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-matrix-convergence.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-original-focused.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-original-focused.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-producer-check.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-producer-generated.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-strict-owner.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/base-strict-owner.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/baseline-evidence.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/before-format.mjs.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/before.py.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/binding.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/candidate-producer-check.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/candidate-producer-generated.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/canonical-equivalence.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/canonical-equivalence.mjs.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/canonical-final.mjs.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/canonical-formatter.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/canonical-pass-1.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/canonical-pass-1.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/canonical-pass-2.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/canonical-pass-2.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/commands.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/current-issue-comments.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/current-issue.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/equivalence.mjs.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/exact-leaf-identities.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/exact-ledger-conflicts.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/final-layout-pass-1.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/final-layout-pass-1.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/final-layout-pass-2.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/final-layout-pass-2.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/format.py.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/generated-prerequisite.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/impacted-matrix-convergence-member.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/impacted-matrix-convergence-member.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/impacted-matrix-history-member.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/impacted-matrix-history-member.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/install-commands.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/latest-master-merge-tree.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/latest-master-merge-tree.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/latest-master-observation.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/leaf-generated-bindings.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/leaf-generated-bindings.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/leaf-original-focused.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/leaf-original-focused.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/leaf-promoted-exact-retention.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/leaf-promoted-exact-retention.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/leaf-retention-negative-controls.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/leaf-retention-negative-controls.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/leaf-strict-style.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/leaf-strict-style.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/local-pr-latest-master-preflight.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/local-pr-preflight.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/matrix-convergence.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/matrix-prerequisite.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/mechanical-commit-message.txt.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/mechanical-equivalence.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/mechanical-formatter.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/mechanical-pass-1.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/mechanical-pass-1.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/mechanical-pass-1.mjs.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/mechanical-pass-2.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/mechanical-pass-2.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/mechanical-pass-2.mjs.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/mechanical-sha.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/narrow-pr-body.md.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/narrow-pr-title.txt.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/observed-toolchain.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/pr-latest-preflight.mjs.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/pr-preflight.mjs.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/promoted-pr3679.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/replacement-owner-install.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/replacement-owner-install.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/results.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/seal.py.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/tests__tools-install.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/tests__tools-install.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/tools__frontend__style-toolchain-install.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/tools__frontend__style-toolchain-install.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/tools__governance__javascript-format-parser-install.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/tools__governance__javascript-format-parser-install.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/tools__test-inventory__ts-ast-adapter-install.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/tools__test-inventory__ts-ast-adapter-install.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/trusted-leaf-range.exit.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/trusted-leaf-range.log.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/unchanged-governance-identities.json.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-proof/verify.py.gz`
- `A artifacts/style/suite-convergence-narrow-leaf-verification.json`
- `M tests/tools/test-suite-convergence.test.mjs`

## Change Classification

- [ ] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [ ] Public contract change
- [ ] External naming exception
- Contract impact: none

The aggregate contains separate preserved mechanical/syntax commits, so the PR aggregate is not classified as format-only. The SOURCE port adds tooling behavior only in the active integration branch.

## Tests Run

- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests:
- [x] Targeted frontend checks: recorded owner style PASS at `945a25a6cdf9b225e2acca705b2a3e6eddf8667b`; no test rerun for this handoff.
- [x] Other: recorded checks below, each bound to its stated SHA; [SHA-bound verification evidence](https://github.com/Ozwasyd/FsusBlog/blob/3b901b7ebab3c59b4cc145b3645a659bb562f6b0/artifacts/style/suite-convergence-narrow-leaf-verification.json).

HISTORICAL PASS at `945a25a6cdf9b225e2acca705b2a3e6eddf8667b`: strict leaf style with zero diagnostics; exact retention diff; 23 replacement controls and 14 history controls; original trusted range.

HISTORICAL FAIL at `945a25a6cdf9b225e2acca705b2a3e6eddf8667b`: original leaf controls 16 passed / 1 failed / 17 total / 0 skipped; canonical generated check exits 1; original convergence check reports 10 errors. These older failures are retained as historical results, not asserted as the latest continuation results.

UNRUN at remote head `3b901b7ebab3c59b4cc145b3645a659bb562f6b0` against current master `537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`: new candidate verification, complete SOURCE, actual GitHub PR gate, independent acceptance, compiled/PG/runtime/full CI. No old receipt is promoted to current qualification.

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

- Exceptions manifest: none

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
- Summary: preserve the original suite convergence leaf snapshot

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

No generated runtime output is changed; evidence artifacts do not replace source/runtime acceptance.

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
