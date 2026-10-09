## Linked Issue

Refs #2398

Related to [#2408](https://github.com/Ozwasyd/FsusBlog/issues/2408), [#2400](https://github.com/Ozwasyd/FsusBlog/issues/2400), [#2410](https://github.com/Ozwasyd/FsusBlog/issues/2410) and [#3663](https://github.com/Ozwasyd/FsusBlog/issues/3663). WIP; none is accepted.

## Scope Summary

- Title: `fix(backend): recheck property observations before returning group plans`.
- Branch `codex/chain-3663-group-property-recheck`; actual tested/published source `983dd6eef8aab4eab5173d1abea3baf2b972a6b2`. Evidence-only publication may advance HEAD; the sole PR writer must fill its verified remote SHA, without retargeting the compiled source receipt.
- An early member could change or lose permission while later members were read. Final authorized reads now rebind and compare held observations before returning any group plan. Revocation/cancellation propagate; refusal returns no partial result. This is not an atomic group fence or export grant.
- Direct source delta to `3d177f17fa34bdf322447f1ea917469d2c938869`: current property reader, current-properties planner partial, existing source-port tests and maintained API docs. Released asset/version-worker files remain unchanged.
- Intended base master inspected at `537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea`. Full PR inherits the entire earlier finite package/kernel/document-export source closure plus raw evidence; every prospective changed path is listed below. Narrow component checks do not approve this full inherited diff.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [x] Public contract change
- [x] External naming exception
- Contract impact: compatible; fail-closed extra observations, full-diff review pending

## Tests Run

- [ ] `./tools/test.sh fast`: original held stage, UNRUN
- [ ] Targeted backend tests: full original Server project/SQL/audit/native qualification UNRUN/HOLD
- [ ] Targeted frontend checks: UNRUN; no UI/caption product claim
- [x] Other: PASS at `983dd6eef8aab4eab5173d1abea3baf2b972a6b2` — audited locked restore, strict110whole-file component compile0warnings/0errors,628/628tests0failed/skipped,3changed-file style and new commit-range checks. See `artifacts/article-packages/chain-3663-group-property-recheck/final-report.json` and raw TRXs.
- [x] Other: FAIL retained at test-only `149fb214c28d6fe7a14cd18c7e707b921089b8dc` —11/11new group controls failed on unchanged product behavior. Earlier fixture format build failed3IDE0055 diagnostics. All assertions remain.
- [x] Other: FAIL — maintained API docs still report26inherited diagnostics, unwaived.
- [ ] Other: trusted-base full PR-body/naming/style gate, original trust31controls on this candidate, full matrix/native/provider/DB/HTTP/product/independent acceptance and performance/mutation/caption round-trip remain UNRUN/HOLD.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

## Coding Convention

- [ ] C# mother-style mapping checked for full inherited diff
- [x] Formatter/linter run: actual3changed source/test files; complete inherited scope pending
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [ ] `.git-blame-ignore-revs` updated when applicable
- Formatter identity: repository-owned dotnet format/check-csharp-style
- Formatter version: SDK10.0.302
- Formatter command: exact positive-file command recorded under the group recheck evidence
- Formatter idempotence evidence: none
- Blame-ignore revision: none claimed by this behavior increment; inherited formatting remains separately recorded

## External Naming Exception

- Exceptions manifest: WIP — changed per-component article-package naming manifests preserve their exact scopes; no single trusted full-PR union manifest/gate has been established. Do not claim the narrow declarations approve all inherited source.

## Documentation / Intent

- [x] Public API docs updated for this increment
- [x] Ownership/security/performance intent updated for this increment
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

## Compatibility And Risk

- [ ] [Cross-language coding conventions](../docs/development/coding-conventions.md) reviewed for full inherited scope
- [ ] Document lifecycle updated: stable facts are current; issue handoffs are historical/proposed; generated docs identify their producer
- [ ] External wire / ABI / database / third-party names preserved or explicitly adapted
- [ ] Public API impact reviewed for full inherited scope
- [ ] AEDS frame / binary contract impact reviewed for full inherited scope
- [ ] Database migration impact reviewed for full inherited scope
- [ ] Security, auth, moderation, PoW, or privacy impact reviewed for full inherited scope
- [x] Docs updated or a reason is recorded below
- [x] Known limitations updated if applicable

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: no benchmark,1000-article runtime or mutation qualification; stable finite plan reads increase from2to3per member

## Release Note

- Audience: internal
- Category: Fixed
- Summary: recheck property observations before returning group plans

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: draft handoff only; no merge, deployment, acceptance or production migration.
- Rollback: revert only this new observation recheck after owner review; preserve original canonical prerequisites, frozen source and all failed controls.
- Deferred work: consume actual asset/version-worker commits; original historical rights reader source; accepted full V1 root and real authorized slug/taxonomy/assets/historical-draft-reference providers; original runtime gates.
- Known limitations: sequential final reads cannot freeze all members or prevent post-read movement. Mocked port fixtures are not DB/signed-audit/live-permission evidence. RequirePropertyAuthority/RequirePackageAuthority still refuse.

## Notes For Reviewers

WIP full-diff gates deliberately remain unchecked. No UI is changed, so UI evidence is not applicable. No original authority/provider/writer/route/schema migration is activated. This increment changes no AEDS/ABI contract. Inherited code still requires independent complete review.

No released asset/version worker file was edited; task admission is not completion. Historical rights CanonicalUrl stays original-reader-owned. Do not infer persisted slug, status or timestamp facts.

[Original producer requests](https://github.com/Ozwasyd/FsusBlog/blob/3d177f17fa34bdf322447f1ea917469d2c938869/artifacts/article-packages/chain-3663-current-property-source/supplier-input-requirements.json) remain: [#2323](https://github.com/Ozwasyd/FsusBlog/issues/2323) production ReadAsync/DI/schema/audit integration, exact authorized historical/draft producer, [#1808](https://github.com/Ozwasyd/FsusBlog/issues/1808)/[#2443](https://github.com/Ozwasyd/FsusBlog/issues/2443) actual operation-bound reference facts, canonical slug/taxonomy/assets/rights/frozen sources and complete original V1 manifests. None is invented or replaced by component digests.

Next original commands only after held-stage release and actual prerequisites: `./tools/test.sh help`; `./tools/test.sh ci-tier backend-fast --fresh`; original `tools/build-with-data-env.sh dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter FullyQualifiedName~AuthoringExtensionPackagePersistenceTests`. Complete original matrix/native/provider/independent runtime gates remain required. These are proposed commands, not new execution receipts.

All16 issues remain OPEN/unaccepted. The coordinating parent alone writes PR content. Existing frozen sources and drafts remain intact; no master push, merge, force-push, issue close, auto-merge, deploy or cross-chain conflict resolution.

Complete prospective changed paths, including inherited scope:

- `.git-blame-ignore-revs`
- `artifacts/article-packages/chain-3663-current-property-source/README.md`
- `artifacts/article-packages/chain-3663-current-property-source/accepted-own-style.command`
- `artifacts/article-packages/chain-3663-current-property-source/accepted-own-style.exit`
- `artifacts/article-packages/chain-3663-current-property-source/accepted-own-style.json`
- `artifacts/article-packages/chain-3663-current-property-source/accepted-own-style.log`
- `artifacts/article-packages/chain-3663-current-property-source/accepted-strict-build.command`
- `artifacts/article-packages/chain-3663-current-property-source/accepted-strict-build.exit`
- `artifacts/article-packages/chain-3663-current-property-source/accepted-strict-build.json`
- `artifacts/article-packages/chain-3663-current-property-source/accepted-strict-build.log`
- `artifacts/article-packages/chain-3663-current-property-source/all-issue-status.json`
- `artifacts/article-packages/chain-3663-current-property-source/artifact-sha256.json`
- `artifacts/article-packages/chain-3663-current-property-source/canonical-kernel-final-blobs.json`
- `artifacts/article-packages/chain-3663-current-property-source/capture.py`
- `artifacts/article-packages/chain-3663-current-property-source/compiled-source-closure.json`
- `artifacts/article-packages/chain-3663-current-property-source/current-owned-issues.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-adapter-build-fixed.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-adapter-build-fixed.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-adapter-build-fixed.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-adapter-build-fixed.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-adapter-build.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-adapter-build.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-adapter-build.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-adapter-build.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-build.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-build.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-build.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-build.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-fixed-trx/_bad473dbf38b_2026-10-09_05_39_42_net10.0.trx`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-history-format.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-history-format.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-history-format.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-history-format.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-integration-format.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-integration-format.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-integration-format.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-integration-format.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-locked-restore.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-locked-restore.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-locked-restore.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-locked-restore.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-build-final.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-build-final.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-build-final.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-build-final.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-controls-fixed.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-controls-fixed.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-controls-fixed.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-controls-fixed.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-controls.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-controls.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-controls.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-new-controls.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-own-format-final.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-own-format-final.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-own-format-final.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-own-format-final.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-own-format.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-own-format.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-own-format.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-own-format.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-style-fixed.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-style-fixed.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-style-fixed.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-style-fixed.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-style.command`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-style.exit`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-style.json`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-style.log`
- `artifacts/article-packages/chain-3663-current-property-source/diagnostic-trx/_bad473dbf38b_2026-10-09_05_37_27_net10.0.trx`
- `artifacts/article-packages/chain-3663-current-property-source/final-candidate-commit-range.command`
- `artifacts/article-packages/chain-3663-current-property-source/final-candidate-commit-range.exit`
- `artifacts/article-packages/chain-3663-current-property-source/final-candidate-commit-range.json`
- `artifacts/article-packages/chain-3663-current-property-source/final-candidate-commit-range.log`
- `artifacts/article-packages/chain-3663-current-property-source/final-candidate-locked-restore.command`
- `artifacts/article-packages/chain-3663-current-property-source/final-candidate-locked-restore.exit`
- `artifacts/article-packages/chain-3663-current-property-source/final-candidate-locked-restore.json`
- `artifacts/article-packages/chain-3663-current-property-source/final-candidate-locked-restore.log`
- `artifacts/article-packages/chain-3663-current-property-source/final-commit-range.command`
- `artifacts/article-packages/chain-3663-current-property-source/final-commit-range.exit`
- `artifacts/article-packages/chain-3663-current-property-source/final-commit-range.json`
- `artifacts/article-packages/chain-3663-current-property-source/final-commit-range.log`
- `artifacts/article-packages/chain-3663-current-property-source/final-docs.command`
- `artifacts/article-packages/chain-3663-current-property-source/final-docs.exit`
- `artifacts/article-packages/chain-3663-current-property-source/final-docs.json`
- `artifacts/article-packages/chain-3663-current-property-source/final-docs.log`
- `artifacts/article-packages/chain-3663-current-property-source/final-locked-restore.command`
- `artifacts/article-packages/chain-3663-current-property-source/final-locked-restore.exit`
- `artifacts/article-packages/chain-3663-current-property-source/final-locked-restore.json`
- `artifacts/article-packages/chain-3663-current-property-source/final-locked-restore.log`
- `artifacts/article-packages/chain-3663-current-property-source/final-own-style.command`
- `artifacts/article-packages/chain-3663-current-property-source/final-own-style.exit`
- `artifacts/article-packages/chain-3663-current-property-source/final-own-style.json`
- `artifacts/article-packages/chain-3663-current-property-source/final-own-style.log`
- `artifacts/article-packages/chain-3663-current-property-source/final-report.json`
- `artifacts/article-packages/chain-3663-current-property-source/final-source-push.command`
- `artifacts/article-packages/chain-3663-current-property-source/final-source-push.exit`
- `artifacts/article-packages/chain-3663-current-property-source/final-source-push.json`
- `artifacts/article-packages/chain-3663-current-property-source/final-source-push.log`
- `artifacts/article-packages/chain-3663-current-property-source/final-strict-build.command`
- `artifacts/article-packages/chain-3663-current-property-source/final-strict-build.exit`
- `artifacts/article-packages/chain-3663-current-property-source/final-strict-build.json`
- `artifacts/article-packages/chain-3663-current-property-source/final-strict-build.log`
- `artifacts/article-packages/chain-3663-current-property-source/final-tests.command`
- `artifacts/article-packages/chain-3663-current-property-source/final-tests.exit`
- `artifacts/article-packages/chain-3663-current-property-source/final-tests.json`
- `artifacts/article-packages/chain-3663-current-property-source/final-tests.log`
- `artifacts/article-packages/chain-3663-current-property-source/final-trx/_bad473dbf38b_2026-10-09_05_49_29_net10.0.trx`
- `artifacts/article-packages/chain-3663-current-property-source/final-verified-tests.command`
- `artifacts/article-packages/chain-3663-current-property-source/final-verified-tests.exit`
- `artifacts/article-packages/chain-3663-current-property-source/final-verified-tests.json`
- `artifacts/article-packages/chain-3663-current-property-source/final-verified-tests.log`
- `artifacts/article-packages/chain-3663-current-property-source/final-verified-trx/_bad473dbf38b_2026-10-09_05_56_12_net10.0.trx`
- `artifacts/article-packages/chain-3663-current-property-source/harness/.editorconfig`
- `artifacts/article-packages/chain-3663-current-property-source/harness/Directory.Build.props`
- `artifacts/article-packages/chain-3663-current-property-source/harness/PropertyCodec.Tests.csproj`
- `artifacts/article-packages/chain-3663-current-property-source/harness/packages.lock.json`
- `artifacts/article-packages/chain-3663-current-property-source/kernel-import.json`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-commit-range.command`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-commit-range.exit`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-commit-range.json`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-commit-range.log`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-docs.command`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-docs.exit`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-docs.json`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-docs.log`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-locked-restore.command`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-locked-restore.exit`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-locked-restore.json`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-locked-restore.log`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-own-style.command`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-own-style.exit`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-own-style.json`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-own-style.log`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-strict-build.command`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-strict-build.exit`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-strict-build.json`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-strict-build.log`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-tests.command`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-tests.exit`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-tests.json`
- `artifacts/article-packages/chain-3663-current-property-source/qualification-tests.log`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-commit-range.command`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-commit-range.exit`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-commit-range.json`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-commit-range.log`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-own-style.command`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-own-style.exit`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-own-style.json`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-own-style.log`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-strict-build.command`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-strict-build.exit`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-strict-build.json`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-strict-build.log`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-tests.command`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-tests.exit`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-tests.json`
- `artifacts/article-packages/chain-3663-current-property-source/repaired-tests.log`
- `artifacts/article-packages/chain-3663-current-property-source/source-push.command`
- `artifacts/article-packages/chain-3663-current-property-source/source-push.exit`
- `artifacts/article-packages/chain-3663-current-property-source/source-push.json`
- `artifacts/article-packages/chain-3663-current-property-source/source-push.log`
- `artifacts/article-packages/chain-3663-current-property-source/source-remote-sha.command`
- `artifacts/article-packages/chain-3663-current-property-source/source-remote-sha.exit`
- `artifacts/article-packages/chain-3663-current-property-source/source-remote-sha.json`
- `artifacts/article-packages/chain-3663-current-property-source/source-remote-sha.log`
- `artifacts/article-packages/chain-3663-current-property-source/supplier-input-requirements.json`
- `artifacts/article-packages/chain-3663-current-property-source/verified-commit-range.command`
- `artifacts/article-packages/chain-3663-current-property-source/verified-commit-range.exit`
- `artifacts/article-packages/chain-3663-current-property-source/verified-commit-range.json`
- `artifacts/article-packages/chain-3663-current-property-source/verified-commit-range.log`
- `artifacts/article-packages/chain-3663-current-property-source/verified-locked-restore.command`
- `artifacts/article-packages/chain-3663-current-property-source/verified-locked-restore.exit`
- `artifacts/article-packages/chain-3663-current-property-source/verified-locked-restore.json`
- `artifacts/article-packages/chain-3663-current-property-source/verified-locked-restore.log`
- `artifacts/article-packages/chain-3663-current-property-source/verified-source-push.command`
- `artifacts/article-packages/chain-3663-current-property-source/verified-source-push.exit`
- `artifacts/article-packages/chain-3663-current-property-source/verified-source-push.json`
- `artifacts/article-packages/chain-3663-current-property-source/verified-source-push.log`
- `artifacts/article-packages/chain-3663-current-property-source/verified-source-remote-sha.command`
- `artifacts/article-packages/chain-3663-current-property-source/verified-source-remote-sha.exit`
- `artifacts/article-packages/chain-3663-current-property-source/verified-source-remote-sha.json`
- `artifacts/article-packages/chain-3663-current-property-source/verified-source-remote-sha.log`
- `artifacts/article-packages/chain-3663-current-property-source/verified-trx/_bad473dbf38b_2026-10-09_05_54_25_net10.0.trx`
- `artifacts/article-packages/chain-3663-group-property-recheck/README.md`
- `artifacts/article-packages/chain-3663-group-property-recheck/artifact-sha256.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/capture.py`
- `artifacts/article-packages/chain-3663-group-property-recheck/compiled-source-closure.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-fixed-build.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-fixed-build.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-fixed-build.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-fixed-build.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-format.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-format.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-format.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-format.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-strict-build.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-strict-build.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-strict-build.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-strict-build.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-tests.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-tests.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-tests.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-tests.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/counterexample-trx/_bad473dbf38b_2026-10-09_06_58_22_net10.0.trx`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-commit-range.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-commit-range.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-commit-range.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-commit-range.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-docs.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-docs.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-docs.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-docs.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-issues/2398-comments.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-issues/2398.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-issues/2400-comments.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-issues/2400.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-issues/2410-comments.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-issues/2410.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-locked-restore.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-locked-restore.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-locked-restore.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-locked-restore.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-sdk.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-sdk.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-sdk.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-sdk.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-strict-build.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-strict-build.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-strict-build.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-strict-build.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-style.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-style.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-style.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-style.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-tests.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-tests.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-tests.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-tests.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/current-trx/_bad473dbf38b_2026-10-09_07_01_31_net10.0.trx`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-locked-restore.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-locked-restore.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-locked-restore.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-locked-restore.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-product-format.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-product-format.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-product-format.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-product-format.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-test-format.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-test-format.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-test-format.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/diagnostic-test-format.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/draft-pr.md`
- `artifacts/article-packages/chain-3663-group-property-recheck/exclusive-claims-preserved.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/final-report.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/harness/.editorconfig`
- `artifacts/article-packages/chain-3663-group-property-recheck/harness/Directory.Build.props`
- `artifacts/article-packages/chain-3663-group-property-recheck/harness/PropertyCodec.Tests.csproj`
- `artifacts/article-packages/chain-3663-group-property-recheck/harness/packages.lock.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/source-push.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/source-push.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/source-push.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/source-push.log`
- `artifacts/article-packages/chain-3663-group-property-recheck/source-remote.command`
- `artifacts/article-packages/chain-3663-group-property-recheck/source-remote.exit`
- `artifacts/article-packages/chain-3663-group-property-recheck/source-remote.json`
- `artifacts/article-packages/chain-3663-group-property-recheck/source-remote.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/README.md`
- `artifacts/article-packages/chain-3663-strict-source-closure/all-issue-status.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/artifact-sha256.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/capture.py`
- `artifacts/article-packages/chain-3663-strict-source-closure/compiled-source-closure.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/current-owned-issues.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-commit-range.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-commit-range.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-commit-range.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-commit-range.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-direct-lint.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-direct-lint.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-direct-lint.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-direct-lint.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-literal-lint.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-literal-lint.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-literal-lint.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-literal-lint.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-style.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-style.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-style.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/evidence-readme-style.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-commit-range.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-commit-range.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-commit-range.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-commit-range.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-evidence-push.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-evidence-push.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-evidence-push.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-evidence-push.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-evidence-remote-sha.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-evidence-remote-sha.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-evidence-remote-sha.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-evidence-remote-sha.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-locked-restore.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-locked-restore.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-locked-restore.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-locked-restore.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-report.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-sdk.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-sdk.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-sdk.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-sdk.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-strict-build.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-strict-build.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-strict-build.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-strict-build.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-style.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-style.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-style.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-style.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-tests.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-tests.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-tests.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/final-tests.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/formatter-first-digest.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/formatter-first.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/formatter-first.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/formatter-first.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/formatter-first.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/formatter-second-digest.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/formatter-second.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/formatter-second.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/formatter-second.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/formatter-second.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/harness-file-hashes.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/harness/.editorconfig`
- `artifacts/article-packages/chain-3663-strict-source-closure/harness/Directory.Build.props`
- `artifacts/article-packages/chain-3663-strict-source-closure/harness/PropertyCodec.Tests.csproj`
- `artifacts/article-packages/chain-3663-strict-source-closure/harness/packages.lock.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/imported-source-provenance.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/preimages.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/property-api-readonly/ArticlePropertyValueContracts.cs`
- `artifacts/article-packages/chain-3663-strict-source-closure/property-api-readonly/ArticlePropertyValuePersistence.Read.cs`
- `artifacts/article-packages/chain-3663-strict-source-closure/property-api-readonly/ArticlePropertyValuePersistence.cs`
- `artifacts/article-packages/chain-3663-strict-source-closure/property-api-readonly/ArticlePropertyValueReadContracts.cs`
- `artifacts/article-packages/chain-3663-strict-source-closure/property-api-readonly/ArticleService.ArticlePropertyValues.cs`
- `artifacts/article-packages/chain-3663-strict-source-closure/property-api-readonly/AuthoringArticleCurrentSourceReader.cs`
- `artifacts/article-packages/chain-3663-strict-source-closure/property-api-readonly/IArticlePropertyValueAuthority.cs`
- `artifacts/article-packages/chain-3663-strict-source-closure/property-api-readonly/identity.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/property-api-readonly/property-3665-minimal-handoff.md`
- `artifacts/article-packages/chain-3663-strict-source-closure/publication-verification.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/published-source-push.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/published-source-push.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/published-source-push.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/published-source-push.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/published-source-remote-sha.command`
- `artifacts/article-packages/chain-3663-strict-source-closure/published-source-remote-sha.exit`
- `artifacts/article-packages/chain-3663-strict-source-closure/published-source-remote-sha.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/published-source-remote-sha.log`
- `artifacts/article-packages/chain-3663-strict-source-closure/supplier-input-requirements.json`
- `artifacts/article-packages/chain-3663-strict-source-closure/trx/_1c6b98fee6cc_2026-10-08_15_12_07_net10.0.trx`
- `artifacts/change-contract/article-package-frozen-export-candidate-external-naming.json`
- `artifacts/change-contract/article-package-import-candidate-external-naming.json`
- `artifacts/change-contract/article-package-import-zip-candidate-external-naming.json`
- `artifacts/change-contract/article-package-manifest-asset-metadata-external-naming.json`
- `artifacts/change-contract/article-package-manifest-candidate-external-naming.json`
- `artifacts/change-contract/article-package-manifest-metadata-external-naming.json`
- `artifacts/change-contract/article-package-manifest-property-external-naming.json`
- `artifacts/change-contract/article-package-manifest-taxonomy-external-naming.json`
- `artifacts/change-contract/article-package-property-mapping-review-external-naming.json`
- `artifacts/change-contract/article-package-title-summary-external-naming.json`
- `artifacts/style/document-export-canonical-adapter-idempotence.json`
- `docs/api/contracts.md`
- `src/backend/Services/Authoring/ArticlePackageAssetMetadataMapper.cs`
- `src/backend/Services/Authoring/ArticlePackageCurrentPropertyReader.cs`
- `src/backend/Services/Authoring/ArticlePackageFrozenExportCandidateWriter.cs`
- `src/backend/Services/Authoring/ArticlePackageManifestCandidatePlanner.CurrentProperties.cs`
- `src/backend/Services/Authoring/ArticlePackageManifestCandidatePlanner.cs`
- `src/backend/Services/Authoring/ArticlePackageManifestPropertyBinder.cs`
- `src/backend/Services/Authoring/ArticlePackagePropertyMapper.cs`
- `src/backend/Services/Authoring/ArticlePackageTitleSummaryMapper.cs`
- `src/backend/Services/Authoring/ArticlePropertyDefinitionAuthorityContracts.cs`
- `src/backend/Services/Authoring/ArticlePropertyReferenceValueAuthority.cs`
- `src/backend/Services/Authoring/ArticlePropertyValueDefinitionValidation.cs`
- `src/backend/Services/Authoring/ArticlePropertyValuePersistence.Read.cs`
- `src/backend/Services/Authoring/ArticlePropertyValuePersistence.Storage.cs`
- `src/backend/Services/Authoring/ArticlePropertyValuePersistence.cs`
- `src/backend/Services/Authoring/ArticlePropertyValueValidator.cs`
- `src/backend/Services/Authoring/IArticlePropertyValueAuthority.cs`
- `src/backend/Services/DocumentExport/CanonicalDocumentRendererAdapter.cs`
- `src/backend/Services/DocumentExport/DocumentExportAttemptDeadline.cs`
- `src/backend/Services/DocumentExport/DocumentExportAttemptResources.cs`
- `src/backend/Services/DocumentExport/DocumentExportContractValidator.cs`
- `src/backend/Services/DocumentExport/DocumentExportContracts.cs`
- `src/backend/Services/DocumentExport/DocumentExportFrozenEmbeds.cs`
- `src/backend/Services/DocumentExport/DocumentExportHtmlSanitizer.cs`
- `src/backend/Services/DocumentExport/DocumentExportSandbox.cs`
- `src/backend/Services/DocumentExport/Jobs/DocumentExportJobContracts.cs`
- `src/backend/Services/DocumentExport/SelfContainedHtmlDocumentExportProvider.cs`
- `src/shared/Contracts/ArticleEmbeds/Relations/ArticleEmbedFrozenDependencyProjection.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageChecksums.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageIdentity.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateBytes.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidatePlanner.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageImportZipCandidateReader.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageImportZipDirectory.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageInventory.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageManifestAssetMetadata.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageManifestCandidateCodec.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageManifestCandidateContracts.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageManifestMetadataCodec.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageManifestMetadataContracts.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageManifestPropertyCodec.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageManifestTaxonomyCodec.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageManifestTaxonomyContracts.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackagePropertyMappingContracts.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageSourceBytes.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageTitleSummaryContracts.cs`
- `src/shared/Contracts/ArticleProperties/ArticlePropertyValueContracts.cs`
- `src/shared/Contracts/ArticleProperties/ArticlePropertyValueDigest.cs`
- `src/shared/Contracts/ArticleProperties/ArticlePropertyValueMutationContracts.cs`
- `src/shared/Contracts/ArticleRelations/ArticleRelationContractValidator.cs`
- `tests/backend/Unit/ArticlePackageAssetMetadataMapperTests.cs`
- `tests/backend/Unit/ArticlePackageChecksumTests.cs`
- `tests/backend/Unit/ArticlePackageCurrentPropertyReaderTests.cs`
- `tests/backend/Unit/ArticlePackageFrozenExportCandidateWriterTests.cs`
- `tests/backend/Unit/ArticlePackageImportCandidateByteTests.cs`
- `tests/backend/Unit/ArticlePackageImportCandidatePlanTests.cs`
- `tests/backend/Unit/ArticlePackageImportZipCandidateTests.cs`
- `tests/backend/Unit/ArticlePackageInventoryTests.cs`
- `tests/backend/Unit/ArticlePackageManifestCandidateCodecTests.cs`
- `tests/backend/Unit/ArticlePackageManifestCandidatePlannerTests.cs`
- `tests/backend/Unit/ArticlePackageManifestMetadataCodecTests.cs`
- `tests/backend/Unit/ArticlePackageManifestPropertyCodecTests.cs`
- `tests/backend/Unit/ArticlePackageManifestTaxonomyCodecTests.cs`
- `tests/backend/Unit/ArticlePackagePropertyMapperTests.cs`
- `tests/backend/Unit/ArticlePackageSourceByteTests.cs`
- `tests/backend/Unit/ArticlePackageTitleSummaryMapperTests.cs`
- `tests/backend/Unit/ArticlePropertySingleSelectStorageTests.cs`
- `tests/backend/Unit/ArticlePropertyValueFoundationTests.cs`
