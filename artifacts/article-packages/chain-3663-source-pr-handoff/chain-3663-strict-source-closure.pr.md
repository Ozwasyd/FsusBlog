## Linked Issue

Refs #2398

Related to [#3663](https://github.com/Ozwasyd/FsusBlog/issues/3663), [#2398](https://github.com/Ozwasyd/FsusBlog/issues/2398), [#2408](https://github.com/Ozwasyd/FsusBlog/issues/2408), [#2400](https://github.com/Ozwasyd/FsusBlog/issues/2400), [#2410](https://github.com/Ozwasyd/FsusBlog/issues/2410), [#2402](https://github.com/Ozwasyd/FsusBlog/issues/2402) and [#2411](https://github.com/Ozwasyd/FsusBlog/issues/2411). WIP handoff; no issue is accepted by this PR.

## Scope Summary

- Branch `codex/chain-3663-strict-source-closure`, verified remote HEAD `7c3a95429f2379ea60a80942244193977e18c5b2`; intended base `master`, read at `be7c53d99b64342925ca63d061bacde34d22ba4c`.
- Complete 105-whole-file component closure includes package codecs/planners/exporter plus canonical document-export and relation dependencies, format-only adapter changes and raw evidence. The entire inherited diff remains WIP.
- Full master three-dot diff: 162 paths, including 57 source/test/tool/config paths and 103 artifact paths. All inherited paths are listed below; this draft must not be reviewed or approved as only its latest component.
- [Complete immutable diff](https://github.com/Ozwasyd/FsusBlog/compare/be7c53d99b64342925ca63d061bacde34d22ba4c...7c3a95429f2379ea60a80942244193977e18c5b2). All merge bases: `aaba7b8c84ecfb336c71443e30d9fd82d21fb16d`; selected three-dot merge base: `aaba7b8c84ecfb336c71443e30d9fd82d21fb16d`. Multiple merge bases, if present, must be reviewed explicitly at the final conflict phase.
- This exact head is an ancestor of current integration `3d177f17fa34bdf322447f1ea917469d2c938869`. Its original implementation history is retained there, but later source changes and reviews must be checked individually. This branch remains available for the user-requested draft handoff; do not merge it separately merely because it is an ancestor.

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
- [x] Other: PASS read-only inventory at exact remote HEAD `7c3a95429f2379ea60a80942244193977e18c5b2`: remote identity, complete name/status/numstat, inherited paths, merge bases, exact source blob comparisons and matching PR records inspected. This is source inventory, not a test/build/runtime qualification.
- [x] Other: PASS only at actual compiled source `cb01ec851e132bdf3e69596d2b5077c56f5350b2`: audited locked component restore, strict compile (0 warnings/errors), 571/571 controls (0 failed/skipped), two positive-file style checks and commit-range governance. Actual closure: 105 whole source files. Evidence: `artifacts/article-packages/chain-3663-strict-source-closure/`.
- [x] Other: source/test/tool/config tree is unchanged between that compiled candidate and remote HEAD `7c3a95429f2379ea60a80942244193977e18c5b2`; later raw evidence/document commits do not retarget the compiled receipt.
- [x] Other: FAIL — inherited API docs baseline has 26 unwaived diagnostics; no rerun for this inventory.
- [ ] Other: trusted-base PR-body/full-diff naming/style gate, complete declared matrix, independent runtime acceptance, performance/mutation and 1000-article/caption round-trip remain UNRUN/HOLD. Do not rerun held stages until their original owner releases them.


Earlier clean-tree captures at the exact remote HEAD (read-only aggregation, not fresh acceptance):

- PASS: `source-check` capture `published-final-commit-range` at `7c3a95429f2379ea60a80942244193977e18c5b2`, exit 0. Public archived record: `artifacts/article-packages/chain-3663-source-pr-handoff/receipts/chain-3663-strict-source-closure/published-final-commit-range.json`. Applies only to the captured command scope.

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
- Summary: preserve the strict package source closure

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

- `.git-blame-ignore-revs`
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
- `src/backend/Services/Authoring/ArticlePackageFrozenExportCandidateWriter.cs`
- `src/backend/Services/Authoring/ArticlePackageManifestCandidatePlanner.cs`
- `src/backend/Services/Authoring/ArticlePackageManifestPropertyBinder.cs`
- `src/backend/Services/Authoring/ArticlePackagePropertyMapper.cs`
- `src/backend/Services/Authoring/ArticlePackageTitleSummaryMapper.cs`
- `src/backend/Services/Authoring/ArticlePropertyReferenceValueAuthority.cs`
- `src/backend/Services/Authoring/ArticlePropertyValueDefinitionValidation.cs`
- `src/backend/Services/Authoring/ArticlePropertyValueValidator.cs`
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
- `src/shared/Contracts/ArticleRelations/ArticleRelationContractValidator.cs`
- `tests/backend/Unit/ArticlePackageAssetMetadataMapperTests.cs`
- `tests/backend/Unit/ArticlePackageChecksumTests.cs`
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
- `tests/backend/Unit/ArticlePropertyValueFoundationTests.cs`

Changed per-component naming manifests (no union admission claimed):

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

Source paths not byte-identical to master or current integration (exact divergence, not proof of unique intended behavior):

- `src/backend/Services/Authoring/ArticlePackageManifestCandidatePlanner.cs`
- `src/backend/Services/Authoring/ArticlePropertyValueValidator.cs`
- `tests/backend/Unit/ArticlePropertyValueFoundationTests.cs`
