# Resolution preparation source WIP

Related issues: #2404 and #2413. Neither issue is complete or closed.

## Exact source binding

- Selected base and PR base: `1016c633466fb18083a8ac0f6cc56e9bb448b99f` (#4335).
- Source checkpoint: `b33e74337bfa0b75b7142cc48bcdfc144e9adade`.
- Branch: `codex/article-package-resolution-preparation`.
- Original saved checkout remains `/workspace/FsusBlog`, clean `work` at
  `29051db2a80db7770dfe78a1db6e4c6998337324`.
- Only three new ordinary C# source files are authored. No existing source is
  overwritten, no frontend/CanvasPackage/FsusUI file is changed, and no donor
  source, runtime observation, frozen receipt, catalog or fixture is admitted.
- Final delivery HEAD is the GitHub PR head (includes this ordinary WIP document).
  This document cannot bind its own containing commit; use the exact PR readback.

## Blocking prerequisite gap

The selected base has no `src/shared/Contracts/ArticlePackages/` directory and no
CandidatePlanner, ReviewContracts, ReviewProjection, ManifestCandidate or typed
package mapper. The three-file candidate deliberately references the existing
owners instead of adding another resolution or mapping engine. It therefore
**does not compile on the selected base**: original complete Server build exits 1
with 22 missing-type errors. This regression is visible and blocks integration.
Do not merge this WIP or describe the dependency diagnostic as candidate PASS.

A scope clarification about prerequisite intake is pending. No unanswered question
is interpreted as permission to compose additional donor source. A separate exact
prerequisite source composition and its independent review are required.

## Implemented preparation boundary

- Closed explicit Map/Create/Skip intent; null/zero/unknown actions, missing choices,
  duplicate sources, broad rules and extra choices refuse without a partial proposal.
- Exact portable identity/version/digest, shape type/constraints fingerprints and
  cardinality match; stable target IDs use canonical integer or UUID spelling.
  No display-name, slug, filename, URL or first-match lookup exists.
- Each declared loss binds affected portable article, field identity, value digest
  and consequence digest. Skip requires that exact item digest; no global default.
- Owned bounded copies: at most 1000 declared items and 10000 total loss coordinates.
  All choices bind actor and UTC choice time; digests use explicit length-prefixed
  UTF-8 fields and big-endian integers, with domain separation and null markers.
- Create is only schema intent with no target or receipt. Canonical creation is not
  called and remains pending. No issuer, reader, executor or grant is introduced.
- Existing CandidatePlanner creates a distinct immutable blocked candidate over the
  original manifest. The old plan is retained; original targets/mode/actor/policy
  and all 11 RequiredAuthorities remain unchanged. RequireExecutionAuthority still
  delegates to the original unconditional refusal. ExecuteDisabled is always true
  and HasObservedResolution is always false.
- ValidateBinding recomputes the whole supplied proposal and rejects supplied
  package/site/schema/catalog/permission/policy/target/revision/choice drift. It
  cannot detect an unobserved store change; replayed assertions are not authority.
- Backend preparation validates the exact full manifest article set through the
  existing typed mapper and source snapshot coordinates/digests before proposing.
  Read projection delegates to the original paginated ReviewProjection.

The declared item set is not independently extracted from a complete package, and
structural validation does not prove unresolved closure or compatibility with real
current targets. Zero articles/assets writes is a source boundary here, not a
measured runtime zero-write observation. No executable plan or creation/mapping
receipt is produced. Original immutable plans remain available; durable append-only
journaling, attempts and idempotency are not implemented by this source leaf.

## Static verification

All checks below are static. No test body, test collection/discovery, product module
import execution, application, native/DB/browser, helper, receipt/catalog/fixture
producer or qualification was invoked. Original projects, source inclusion, refs,
analyzers, configuration and warning policies remain intact.

Tool environment: original SDK `/workspace/.setup/dotnet` (10.0.401), task CLI home
`/tmp/article-resolution-dotnet`, existing NuGet cache `/workspace/.setup/nuget`.
No security setting, rule, baseline, lock or dependency configuration was changed.

- Clean exact base locked restore and full Server build: exit 0, 330 warnings,
  0 errors. Clean base checks use `/tmp/FsusBlog-resolution-base-check`.
- Actual final three-file candidate full Server build: exit 1, 22 missing-type
  errors. No reduced project or suppressed warning is used.
- Original strict C# source checker on all three authored leaves: exit 0,
  files=3, violations=0, new=0. Whitespace formatter ran only on those leaves.
- Original authoritative docs source checker: exit 1, 41 diagnostics. Complete
  base/candidate output is byte-identical.
- Original code-intent checker: exit 1, same two baseline diagnostics in
  `authoringCanvasSpatialIndex.ts` and `font_theme_admin_pods.hpp`; diagnostic lines
  are identical (checked-file count increases by the three source leaves).
- Full-project API dependency diagnostic: clean selected base plus the exact 25
  ordinary source inputs listed below and the same three authored leaves, using
  `/tmp/FsusBlog-resolution-dependency-check`. Locked restore/full Server build
  exit 0, 330 warnings, 0 errors; complete compiler warning multiplicity added 0,
  removed 0 versus clean base after only root/location normalization. This private
  composition is **not** the PR candidate, accepted dependency intake or runtime
  verification.
- An earlier full-tree #4155 diagnostic plus #4012 mapper failed with 344 warnings
  and one missing ArticlePropertyValueValidator error. It was superseded as an API
  diagnostic by the exact-base composition above; the failure is retained locally.
- Source staged diff whitespace and commit-message contract checks pass. Final
  range and actual REST metadata checks are recorded in the PR delivery.

Commands (with the tool environment above):

```bash
dotnet restore src/backend/FsusBlog.Server.csproj --locked-mode
dotnet build src/backend/FsusBlog.Server.csproj --no-restore --nologo -v:minimal
node tools/dotnet/check-csharp-style.mjs --mode strict-full --file src/shared/Contracts/ArticlePackages/ArticlePackageImportResolutionContracts.cs --file src/shared/Contracts/ArticlePackages/ArticlePackageImportResolutionPlanner.cs --file src/backend/Services/Authoring/ArticlePackageImportResolutionPreparation.cs
node tools/docs/check-authoritative-development-docs.mjs
node tools/governance/check-code-intent.mjs
```

## Diagnostic-only prerequisite inputs

These are exact source references used only in the private full-project diagnostic.
They are absent from the PR delta and are not a frozen product catalog, receipt or
independent acceptance. The 25-file set is sufficient for this diagnostic; no
claim is made that it is the minimal or complete production capability closure.

```text
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageCandidateReviewReadContracts.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageCandidateReviewWireValidation.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageChecksums.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageIdentity.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateBytes.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidatePlanner.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateReviewContracts.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageImportZipCandidateReader.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageImportZipDirectory.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageInventory.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageManifestAssetCollection.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageManifestAssetMetadata.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageManifestCandidateCodec.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageManifestCandidateContracts.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageManifestMetadataCodec.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageManifestMetadataContracts.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageManifestPropertyCodec.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageManifestTaxonomyCodec.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageManifestTaxonomyContracts.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageManifestVersionRegistry.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackagePropertyMappingContracts.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageSourceBytes.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/shared/Contracts/ArticlePackages/ArticlePackageTitleSummaryContracts.cs
90f5c2b1a40c85c5efd32514e359f42d59ca9cb1 src/backend/Services/Authoring/ArticlePackageImportCandidateReviewProjection.cs
569518458ad4aa27cbc885417121a2e04cb74254 src/backend/Services/Authoring/ArticlePackagePropertyMapper.cs
```

## Remaining work and HOLD

Prerequisite intake/review and a successful build on the actual PR candidate are
blocking. The original #2404/#2413 acceptance union remains open: real canonical
mapping/creation observations, exact owner schemas/options/constraints, rights,
permissions and lifecycle validation, current-store drift, asset/link/anchor
resolution, complete unresolved extraction, immutable executable replan, append-only
journal/idempotency, independent verifier, static mutation controls and full original
runtime/acceptance matrices. No issue criteria are waived by the other issue.

All 11 original RequiredAuthorities remain missing. No application/DB/native/browser
activation, tests/discovery/import execution, frozen generation, grants, merge,
Ready transition, issue closure, package publication or deployment is authorized
or performed. This source leaf remains unconnected and non-admitting.

Rollback: omit or revert only the three source leaves and this WIP document. No
existing source, live data, native resource or physical schema was modified.

## Local raw static logs

Full raw logs remain in `/tmp/article-resolution-checks/` in the shared workspace.
These are ordinary diagnostic logs, not qualification receipts. SHA-256 values for
completed final checks:

- `final-candidate-build.log`: `8e0dca687e14911b5f7e851988aafbdcbf823c3871e322dbd3a2374be2348e0e`
- `final-style.log`: `58217e7675dae3f3a8a6e9003bc3fe122abf5b9d6cedb3f1d71d4e1c0777e941`
- `base-docs.log`: `7ef7c37f2d494d72fcc2ae562ad45efee5044fa9ff83037812499955ee214403`
- `docs.log`: `7ef7c37f2d494d72fcc2ae562ad45efee5044fa9ff83037812499955ee214403`
- `base-intent.log`: `09aec40e84ef9a1d3f6b767e561ffdf1b5b5edad476fb56e93cb4ef1c81522c6`
- `intent.log`: `90db23da9bccaa32749134506e265b8f1e63ecc3e653d9b4432d43396fd3c4eb`
- `final-dependency-diagnostic-build.log`: `b85930029cf9e0ac641a5ac06caa8a194905b1ee451db2f770e5b5cacef1de95`
- `clean-base-restore.log`: `d82e579c181cd147e8f9a41c6c8b7cdf06bc228bb66d0eb420376625a215fda9`
- `clean-base-build.log`: `7e92a54adf2e1954afe9d9645458eaf19182190583895a55c752322b8650a646`
- `final-docs.log`: `7ef7c37f2d494d72fcc2ae562ad45efee5044fa9ff83037812499955ee214403`
