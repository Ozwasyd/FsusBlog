## Linked Issue

Refs #2398

Related to [#3663](https://github.com/Ozwasyd/FsusBlog/issues/3663), [#2398](https://github.com/Ozwasyd/FsusBlog/issues/2398), [#2408](https://github.com/Ozwasyd/FsusBlog/issues/2408), [#2400](https://github.com/Ozwasyd/FsusBlog/issues/2400), [#2410](https://github.com/Ozwasyd/FsusBlog/issues/2410), [#2402](https://github.com/Ozwasyd/FsusBlog/issues/2402) and [#2411](https://github.com/Ozwasyd/FsusBlog/issues/2411). WIP handoff; no issue is accepted by this PR.

## Scope Summary

- Branch `codex/chain-3663-portable-property-mapping`, verified remote HEAD `fb4d18e9342716def4dca6a73d102f7246e42846`; intended base `master`, read at `be7c53d99b64342925ca63d061bacde34d22ba4c`.
- Explicit portable property binding alone accepts caller candidates, not persisted provenance. The newer current source integration supersedes this mapping use; broad inherited tooling/locks are not silently absorbed.
- Full master three-dot diff: 50 paths, including 40 source/test/tool/config paths and 6 artifact paths. All inherited paths are listed below; this draft must not be reviewed or approved as only its latest component.
- [Complete immutable diff](https://github.com/Ozwasyd/FsusBlog/compare/be7c53d99b64342925ca63d061bacde34d22ba4c...fb4d18e9342716def4dca6a73d102f7246e42846). All merge bases: `3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`; selected three-dot merge base: `3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`. Multiple merge bases, if present, must be reviewed explicitly at the final conflict phase.
- This exact head is not an ancestor of current integration. Some exact source blobs match current integration or master; divergent files remain explicitly listed. A same-named file does not establish absorption. No broad import or conflict resolution is authorized.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [x] Public contract change
- [x] External naming exception
- Contract impact: compatible; full inherited diff review pending, no compatibility or release admission inferred

## Tests Run

- [ ] `./tools/test.sh fast`: UNRUN/HOLD on this draft candidate
- [ ] Targeted backend tests: original full Server-project, SQL/audit/native/provider and trust qualification UNRUN/HOLD
- [ ] Targeted frontend checks: UNRUN; no UI or caption round-trip claim
- [x] Other: PASS read-only inventory at exact remote HEAD `fb4d18e9342716def4dca6a73d102f7246e42846`: remote identity, complete name/status/numstat, inherited paths, merge bases, exact source blob comparisons and matching PR records inspected. This is source inventory, not a test/build/runtime qualification.
- [ ] Other: No tests were rerun for inventory. Full inherited branch/matrix/native/runtime/independent acceptance remains UNRUN/HOLD; exact earlier scoped captures are listed below.
- [ ] Other: trusted-base PR-body/full-diff naming/style gate, complete declared matrix, independent runtime acceptance, performance/mutation and 1000-article/caption round-trip remain UNRUN/HOLD. Do not rerun held stages until their original owner releases them.


Earlier clean-tree captures at the exact remote HEAD (read-only aggregation, not fresh acceptance):

- PASS: `source-check` capture `style` at `fb4d18e9342716def4dca6a73d102f7246e42846`, exit 0. Public archived record: `artifacts/article-packages/chain-3663-source-pr-handoff/receipts/chain-3663-portable-property-mapping/style.json`. Applies only to the captured command scope.
- PASS: `test` capture `original` at `fb4d18e9342716def4dca6a73d102f7246e42846`, exit 0; 317 passed / 0 failed / 0 skipped / 317 total. Public archived record: `artifacts/article-packages/chain-3663-source-pr-handoff/receipts/chain-3663-portable-property-mapping/original.json`. Applies only to the captured command scope.
- PASS: `source-check` capture `local-pr-contract` at `fb4d18e9342716def4dca6a73d102f7246e42846`, exit 0. Public archived record: `artifacts/article-packages/chain-3663-source-pr-handoff/receipts/chain-3663-portable-property-mapping/local-pr-contract.json`. Applies only to the captured command scope.
- PASS: `test` capture `strict` at `fb4d18e9342716def4dca6a73d102f7246e42846`, exit 0; 223 passed / 0 failed / 0 skipped / 223 total. Public archived record: `artifacts/article-packages/chain-3663-source-pr-handoff/receipts/chain-3663-portable-property-mapping/strict.json`. Applies only to the captured command scope.
- PASS: `source-check` capture `commit-range` at `fb4d18e9342716def4dca6a73d102f7246e42846`, exit 0. Public archived record: `artifacts/article-packages/chain-3663-source-pr-handoff/receipts/chain-3663-portable-property-mapping/commit-range.json`. Applies only to the captured command scope.

## UI Evidence

- [ ] Screenshots or video attached for UI changes
- [ ] Mobile layout checked
- [ ] Dark mode checked
- [ ] Accessibility and reduced-motion impact considered

## Coding Convention

- [ ] C# mother-style mapping checked for the complete inherited diff
- [ ] Formatter/linter run for the complete inherited diff
- [x] No tool default overrides repository style
- [ ] Mechanical formatting separated from logic in full-diff review
- [ ] `.git-blame-ignore-revs` updated when applicable
- Formatter identity: repository-owned formatter/style tools; narrow recorded evidence does not cover the full PR
- Formatter version: SDK10.0.302 for the current/strict component receipts only; original branch-wide qualification pending
- Formatter command: not newly run for inventory; exact prior public command records keep their own candidate/scope binding
- Formatter idempotence evidence: none
- Blame-ignore revision: none claimed by this behavior PR; inherited revisions require full-diff review

## External Naming Exception

- Exceptions manifest: WIP — full-PR union is not established; changed per-component manifests listed below retain only their recorded scopes

## Documentation / Intent

- [ ] Public API docs updated and reconciled for complete inherited scope
- [ ] Ownership/security/performance intent reviewed for complete inherited scope
- [ ] Historical handoff archived or source-of-truth updated for complete inherited scope
- [ ] TODO/FIXME references valid issues

## Compatibility And Risk

- [ ] [Cross-language coding conventions](../docs/development/coding-conventions.md) reviewed for complete inherited scope
- [ ] Document lifecycle updated: stable facts are current; issue handoffs are historical/proposed; generated docs identify their producer
- [ ] External wire / ABI / database / third-party names preserved or explicitly adapted
- [ ] Public API impact reviewed
- [ ] AEDS frame / binary contract impact reviewed
- [ ] Database migration impact reviewed
- [ ] Security, auth, moderation, PoW, or privacy impact reviewed
- [ ] Docs updated or a reason is recorded below
- [x] Known limitations updated if applicable

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: no measured performance, mutation, 1000-article or complete product acceptance claim

## Release Note

- Audience: internal
- Category: Added
- Summary: map explicit portable property bindings

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: draft handoff only. No merge, auto-merge, deployment, issue closure, production migration or final acceptance.
- Rollback: original owners determine task-scoped revert after full review; do not remove canonical prerequisites, evidence or frozen sibling source.
- Deferred work: accepted complete V1 package root/version registry/privacy/decode-bind; original source/provenance producers; full formal preflight/current resolution/atomic execution/rollback/recovery/outbox/audit/product stages.
- Known limitations: broad inherited source changes are not qualified by a narrow reviewed subset. Mocked component values do not establish persistence, live permission, signed audit or complete package runtime acceptance. Any inherited migration/consumer lock changes require their original owner and exact dependency evidence.

## Notes For Reviewers

WIP is intentional: unchecked full-diff review fields and unresolved naming evidence are not passed gates. UI evidence is not applicable to this source handoff; there is no rendered UI claim. AEDS/ABI, database and permission/privacy effects of inherited paths still need full-diff review; there is no runtime equivalence claim. Diagnostic captures are raw evidence, not an activated public producer or admission grant.

Public prerequisite requests:
- [#2323](https://github.com/Ozwasyd/FsusBlog/issues/2323): original ArticleService `ReadAsync(long actorAdminPrincipalId, ArticlePropertyDefinitionOwner owner, int articleId, CancellationToken)` implementation, production registration/schema/audit dependencies and isolated runtime evidence. Existing API presence is acknowledged; missing handoff cannot be replaced by caller snapshots.
- Original selected historical/publication/draft producer: immutable rows/digest/audit identity bound to exact authorized revision/draft and operation. Current-head reads are not draft/historical authority.
- [#1808](https://github.com/Ozwasyd/FsusBlog/issues/1808) / [#2443](https://github.com/Ozwasyd/FsusBlog/issues/2443): real permission-bearing actor/operation context and exact target revision/lifecycle/cycle facts. Existing `RequireAllowedAsync` returns no target coordinates; no caller Allowed flag is admitted.
- Original complete Base/Local/Server V1 manifests, canonical slug/route/history rights, asset ledger/rights/retention and frozen publication/materializer facts. Component Properties digests do not substitute for original manifest PropertiesSha256.
- [#2317](https://github.com/Ozwasyd/FsusBlog/issues/2317), [#2324](https://github.com/Ozwasyd/FsusBlog/issues/2324), [#1853](https://github.com/Ozwasyd/FsusBlog/issues/1853): later executor/recovery/product gates remain separate; no stage starts before its original prerequisites are accepted.

Next original commands are proposed, not executed for inventory. After the original owner releases held scopes and prerequisites are available, use `./tools/test.sh help`, then `./tools/test.sh ci-tier backend-fast --fresh` and the declared full matrix. Trust original-project controls use `tools/build-with-data-env.sh dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter FullyQualifiedName~AuthoringExtensionPackagePersistenceTests`. Retain original admission, real SDK/native/cgroup/provider/DB resources, isolated backup/restore where applicable, failures/negative controls, fresh run identity and independent acceptance. Full V1 runtime/product/1000-article/mutation/performance/caption round-trip gates remain required. Source inventory and draft publication grant none of them.

No new tests were run merely to prepare this draft. Existing PR3888/4012/3862 and all frozen source remain intact. The coordinating parent is the only GitHub content writer.

Complete changed paths, including inherited files:

- `artifacts/change-contract/article-package-continuation-external-naming.json`
- `artifacts/change-contract/article-package-foundation-external-naming.json`
- `artifacts/change-contract/article-package-property-mapping-external-naming.json`
- `artifacts/change-contract/current-correctness-inventory-generated-binding.json`
- `artifacts/change-contract/issue-3735-canvas-external-naming.json`
- `artifacts/change-contract/shared-governance-external-naming.json`
- `benchmarks/core/packages.lock.json`
- `config/testing/correctness-attempt-producers.json`
- `docs/api/contracts.md`
- `docs/architecture/article-property-value-boundary.md`
- `docs/testing.md`
- `src/backend/Services/Authoring/ArticlePackagePropertyMapper.cs`
- `src/backend/Services/Authoring/ArticlePropertyReferenceValueAuthority.cs`
- `src/backend/Services/Authoring/ArticlePropertyValueDefinitionValidation.cs`
- `src/backend/Services/Authoring/ArticlePropertyValueValidator.cs`
- `src/migration/FsusBlog.Migration.csproj`
- `src/migration/packages.lock.json`
- `src/shared/Contracts/ArticlePackages/ArticlePackageChecksums.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageIdentity.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageInventory.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackagePropertyMappingContracts.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageSourceBytes.cs`
- `src/shared/Contracts/ArticleProperties/ArticlePropertyValueContracts.cs`
- `src/shared/Contracts/ArticleProperties/ArticlePropertyValueDigest.cs`
- `tests/backend/Unit/ArticlePackageChecksumTests.cs`
- `tests/backend/Unit/ArticlePackageInventoryTests.cs`
- `tests/backend/Unit/ArticlePackagePropertyMapperTests.cs`
- `tests/backend/Unit/ArticlePackageSourceByteTests.cs`
- `tests/backend/Unit/ArticlePropertyValueFoundationTests.cs`
- `tests/backend/Unit/AuthoringExtensionRpcBrokerTests.cs`
- `tests/backend/Unit/CanonicalArticleLifecycleScheduledFailureTests.cs`
- `tests/backend/Unit/CanonicalArticleProjectionVerifierTests.cs`
- `tests/backend/Unit/LifecycleHostedBootstrapServiceTests.cs`
- `tests/backend/Unit/RealConcurrencyHarnessTests.cs`
- `tests/backend/Unit/SecurityAdminPolicyDefaultsTests.cs`
- `tests/backend/Unit/TaxonomyExactMetadataTests.cs`
- `tests/backend/packages.lock.json`
- `tests/fixtures/test-matrix/release-final-execution-target-authority.json`
- `tests/governance/test-lifecycle-registry.json`
- `tests/migration/packages.lock.json`
- `tests/test-retention-replacements.json`
- `tests/tools/canonical-article-lifecycle-authority.test.mjs`
- `tests/tools/correctness-attempt-migration.test.mjs`
- `tools/contracts/FsusBlog.AuthSessionObservation/packages.lock.json`
- `tools/contracts/FsusBlog.ConfigErrorSecurityObservation/packages.lock.json`
- `tools/contracts/FsusBlog.ContentLifecycleObservation/packages.lock.json`
- `tools/contracts/FsusBlog.OpenApiObservation/packages.lock.json`
- `tools/contracts/FsusBlog.RuntimeRoleObservation/packages.lock.json`
- `tools/governance/check-canonical-article-lifecycle-authority.mjs`
- `tools/test/correctness-attempt-migration.mjs`

Changed per-component naming manifests (no union admission claimed):

- `artifacts/change-contract/article-package-continuation-external-naming.json`
- `artifacts/change-contract/article-package-foundation-external-naming.json`
- `artifacts/change-contract/article-package-property-mapping-external-naming.json`
- `artifacts/change-contract/current-correctness-inventory-generated-binding.json`
- `artifacts/change-contract/issue-3735-canvas-external-naming.json`
- `artifacts/change-contract/shared-governance-external-naming.json`

Source paths not byte-identical to master or current integration (exact divergence, not proof of unique intended behavior):

- `config/testing/correctness-attempt-producers.json`
- `src/backend/Services/Authoring/ArticlePropertyValueValidator.cs`
- `src/migration/FsusBlog.Migration.csproj`
- `src/migration/packages.lock.json`
- `src/shared/Contracts/ArticlePackages/ArticlePackageChecksums.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageIdentity.cs`
- `src/shared/Contracts/ArticlePackages/ArticlePackageInventory.cs`
- `tests/backend/Unit/ArticlePackageChecksumTests.cs`
- `tests/backend/Unit/ArticlePackageInventoryTests.cs`
- `tests/backend/Unit/ArticlePropertyValueFoundationTests.cs`
- `tests/backend/Unit/AuthoringExtensionRpcBrokerTests.cs`
- `tests/backend/Unit/SecurityAdminPolicyDefaultsTests.cs`
- `tests/backend/Unit/TaxonomyExactMetadataTests.cs`
- `tests/backend/packages.lock.json`
- `tests/fixtures/test-matrix/release-final-execution-target-authority.json`
- `tests/governance/test-lifecycle-registry.json`
- `tests/migration/packages.lock.json`
- `tests/tools/canonical-article-lifecycle-authority.test.mjs`
- `tests/tools/correctness-attempt-migration.test.mjs`
- `tools/contracts/FsusBlog.AuthSessionObservation/packages.lock.json`
- `tools/contracts/FsusBlog.ConfigErrorSecurityObservation/packages.lock.json`
- `tools/contracts/FsusBlog.ContentLifecycleObservation/packages.lock.json`
- `tools/contracts/FsusBlog.OpenApiObservation/packages.lock.json`
- `tools/contracts/FsusBlog.RuntimeRoleObservation/packages.lock.json`
- `tools/governance/check-canonical-article-lifecycle-authority.mjs`
- `tools/test/correctness-attempt-migration.mjs`
