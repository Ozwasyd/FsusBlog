# Resolution preparation source WIP

Related issues: #2404 and #2413. PR #4342 remains draft; neither issue is complete.
This is ordinary source/provenance documentation, not an authority, receipt,
frozen product catalog, fixture, qualification result or independent acceptance.

## Current exact binding

- Selected base and unchanged PR base: `1016c633466fb18083a8ac0f6cc56e9bb448b99f` (#4335).
- Original three authored leaves: `b33e74337bfa0b75b7142cc48bcdfc144e9adade`, unchanged.
- Prior delivery: `a4368e3869d956a06ca7e589c9ad965198b73b36`.
- Necessary donor source composition: `d7eb15bae54ceac5f72f5051ce4e8759177e89ae`.
- Branch: `codex/article-package-resolution-preparation`.
- Final delivery includes only later ordinary WIP/static naming metadata changes;
  read the exact containing HEAD from the PR. This file cannot bind its own commit.
- Original saved checkout `/workspace/FsusBlog` remains clean `work` at
  `29051db2a80db7770dfe78a1db6e4c6998337324`.

The user authorized closing the prerequisite gap using fixed necessary ordinary
inputs from #4155 `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` and #4012 mapper
`569518458ad4aa27cbc885417121a2e04cb74254`. Four expressly excluded surfaces
and seven further unnecessary codec-component files remain absent. Actual PR
source now has 17 added C# files: the original three plus 14 exact whole donor
files. No existing source, project/configuration, route, DI, frontend/CanvasPackage
or FsusUI file is changed. No donor branch/history is merged or cherry-picked.

## File-level minimality

The roots are the three authored preparation leaves and their existing candidate,
review and typed-mapping APIs. Each of the 14 whole-file inputs has a concrete
necessary declaration/use edge in the actual candidate below. Source files are
kept byte-for-byte, including any adjacent types sharing a file; methods or type
members are not extracted or replaced. This is a minimal file closure for these
roots with the fixed whole-file inputs, not a claim of complete ArticlePackage
capability or sufficient runtime authorities. The complete actual Server build
confirms there are no missing compiler dependencies in this closure.

| Necessary input | Consumer in actual candidate | Required reference |
| --- | --- | --- |
| `src/shared/Contracts/ArticlePackages/ArticlePackageChecksums.cs` | `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateBytes.cs:125` | `ArticlePackageChecksums.Verify` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageIdentity.cs` | `src/shared/Contracts/ArticlePackages/ArticlePackageImportResolutionContracts.cs:37` | `ArticlePackageIdentity Source` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateBytes.cs` | `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidatePlanner.cs:48` | `ArticlePackageValidatedImportCandidate candidate` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidatePlanner.cs` | `src/shared/Contracts/ArticlePackages/ArticlePackageImportResolutionPlanner.cs:120` | `ArticlePackageImportCandidatePlanner.TryCreatePlan` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateReviewContracts.cs` | `src/backend/Services/Authoring/ArticlePackageImportCandidateReviewProjection.cs:21` | `ArticlePackageCandidateReview? review` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageInventory.cs` | `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateBytes.cs:87` | `ArticlePackageInventory.Validate` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageManifestCandidateCodec.cs` | `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateBytes.cs:132` | `ArticlePackageManifestCandidateCodec.TryParseCandidate` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageManifestCandidateContracts.cs` | `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateBytes.cs:16` | `ArticlePackageManifestCandidate manifest` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageManifestVersionRegistry.cs` | `src/shared/Contracts/ArticlePackages/ArticlePackageManifestCandidateContracts.cs:51` | `ArticlePackageManifestVersionRegistry.Current.Versions` |
| `src/shared/Contracts/ArticlePackages/ArticlePackagePropertyMappingContracts.cs` | `src/backend/Services/Authoring/ArticlePackageImportResolutionPreparation.cs:10` | `ArticlePackagePropertyMappingBindings Bindings` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageSourceBytes.cs` | `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateBytes.cs:151` | `ArticlePackageSourceBytes.Verify` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageTitleSummaryContracts.cs` | `src/shared/Contracts/ArticlePackages/ArticlePackageManifestCandidateCodec.cs:212` | `ArticlePackageTitleSummaryLimits.MaxCanonicalTextCodeUnits` |
| `src/backend/Services/Authoring/ArticlePackageImportCandidateReviewProjection.cs` | `src/backend/Services/Authoring/ArticlePackageImportResolutionPreparation.cs:107` | `ArticlePackageImportCandidateReviewProjection.TryProject` |
| `src/backend/Services/Authoring/ArticlePackagePropertyMapper.cs` | `src/backend/Services/Authoring/ArticlePackageImportResolutionPreparation.cs:79` | `ArticlePackagePropertyMapper.ValidateCandidate` |

The explicit four exclusions are:

- `ArticlePackageCandidateReviewReadContracts.cs`: transport read-request DTOs are
  not consumed by the retained review read model/projection or preparation roots.
- `ArticlePackageCandidateReviewWireValidation.cs`: wire validation has no retained
  endpoint/request consumer and is not required by these APIs.
- `ArticlePackageImportZipCandidateReader.cs`: archive intake is outside this finite
  already-read byte candidate; its authority remains missing.
- `ArticlePackageImportZipDirectory.cs`: directory parsing belongs to that excluded
  archive reader; no retained source depends on it.

The remaining 21 candidate inputs were examined individually. Fourteen have the
necessary edges above. The other seven are omitted because their types/methods
are not consumed by the retained closure:

- `ArticlePackageManifestAssetCollection.cs`
- `ArticlePackageManifestAssetMetadata.cs`
- `ArticlePackageManifestMetadataCodec.cs`
- `ArticlePackageManifestMetadataContracts.cs`
- `ArticlePackageManifestPropertyCodec.cs`
- `ArticlePackageManifestTaxonomyCodec.cs`
- `ArticlePackageManifestTaxonomyContracts.cs`

Those partial-codec component extensions introduce their own optional APIs and
helpers. The retained candidate codec and typed mapper compile without them.
They are not cut out of any pre-existing source file: they were absent at base,
remain absent, and no underlying helper is copied or reimplemented. Asset,
metadata, property-persistence and taxonomy authorities remain unavailable.

## Exact whole-file provenance

Every destination was absent in base and prior delivery. The Git blob and SHA-256
were recomputed from actual candidate bytes and match the exact donor file. The
source commit above contains only these 14 added leaves (3389 lines).

| Actual candidate path | Donor SHA | Git blob | SHA-256 |
| --- | --- | --- | --- |
| `src/shared/Contracts/ArticlePackages/ArticlePackageChecksums.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `5efd320607c42e54edf6183257b3b8be60d9014b` | `90ae25aa5f712fb98a5b88f041dc609bbc8d54c847e097aae4f53f5a2779683e` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageIdentity.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `fffd88b4664604fadedf7897e98ee92bbdea18c3` | `0fe36244e5fb47cbbdc67c022a3b881e16722980869d8e6743d00967076e2826` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateBytes.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `0349b601d66fed31483639b11f716e6fd8e9ee78` | `f3e0fea81b2a4926202ed19fa236794fac2a511d729377ccb45c5988b63caecc` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidatePlanner.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `703501fe781def4f7818bff75fb7943b24ae2406` | `2280792b9e35d4e1e96be5afc8d7060473ec826fd04485c8bb496e152e3e1604` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateReviewContracts.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `e36842251889f60ca1d59b26d566444ca5b245d3` | `4f36f0c335d3125b65e52f322d03e848de225c2d188c09773b6d9c9ef6d0d062` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageInventory.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `33855d7e02f825aaab609530327cd586346162ea` | `d68ab160127912c8675ab211616bf113a0bd0bbf2e6aaa68ea552ac49aa623f3` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageManifestCandidateCodec.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `c7cc09a894ea454beb7304bd03b0b9197e1d45f6` | `908a108caf94d1bfc1f07b1121fbd27ca2490a4fa404e60aa1053b11a0e00841` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageManifestCandidateContracts.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `56cb3abdac3dbf68abff92dbf79edff41a0fcc89` | `040df41eddd5c6fc751a8c8e7064e71658c8ebc3466cb31fbee9eedb6934c4d6` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageManifestVersionRegistry.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `6722da44ef71c8550a5e42d2c18e138488b8771e` | `c1968a6da626f248e82f9b3c3d8770ae84fb288b14c2f979e51fa56d196a7f42` |
| `src/shared/Contracts/ArticlePackages/ArticlePackagePropertyMappingContracts.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `d364b5e587bb7545ae7784258e2e3798a2c67aea` | `bec4ec1bd472480f6cc8e3e130fac51488fc1b3e44d0d37b16eff220cc0ec9a5` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageSourceBytes.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `b983c751c710118d88642a3a69c0e1a54cabc6e7` | `b15687dfc98d664ee267c9056fe7f3c008eddab1b8f6a3dc8081eab21f99697d` |
| `src/shared/Contracts/ArticlePackages/ArticlePackageTitleSummaryContracts.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `dbfdbb966493224fae21e1f4c192bcd9f5f48674` | `18e5b691b6067a1760bb8bd9c26552d1aa9da6a9928588827e7bce264f3bea51` |
| `src/backend/Services/Authoring/ArticlePackageImportCandidateReviewProjection.cs` | `90f5c2b1a40c85c5efd32514e359f42d59ca9cb1` | `64712805fcc89d0b5d77341437883553a7fa3ed3` | `c5b90c4bee8e7dfaacbbb5345dde4f6cd146278af28821c71049ddbeba246799` |
| `src/backend/Services/Authoring/ArticlePackagePropertyMapper.cs` | `569518458ad4aa27cbc885417121a2e04cb74254` | `9ecc32ddfc6b80c8dba53d1e681759a28b9eaef1` | `8f113d8042f096d219496407b306033a55593b032d3b5fe97fb5b1e001cb4d9b` |

## Preparation and refusal boundaries

- Closed explicit Map/Create/Skip intent rejects null/default/unknown actions,
  missing or duplicate sources, broad rules and extra choices, with no partial
  proposal. Exact identity/version/digest and type/constraints/cardinality match
  are caller assertion checks, not canonical target compatibility observations.
- Stable target IDs have canonical integer/UUID spelling; there is no display-name,
  slug, filename, URL or first-match lookup. The existing typed mapper validates
  every manifest article's exact source snapshot coordinates/digests and supplied
  mapping before preparation; no second mapper or resolution engine is introduced.
- Each loss binds portable article, field, value digest and consequence digest.
  Skip confirms that exact individual loss digest. There is no global skip default.
- Owned bounded copies allow 1000 declared items and 10000 total loss coordinates.
  Actor/time/choice/catalog bindings are hashed with explicit framed UTF-8 fields,
  big-endian integers, null markers and domain separation.
- Create is pending schema intent only: no canonical creation command, identity,
  receipt, issuer, target reader, executor or grant is provided or invoked.
- The original CandidatePlanner creates a distinct blocked immutable candidate over
  the original manifest; old targets/mode/actor/policy are retained. Old plans are
  not patched. The review adapter delegates to the original paginated projection.
- ValidateBinding recomputes supplied assertions and rejects supplied drift. It
  cannot observe a real store change or prove that replayed facts remain current.
- The declared unresolved set is not independently extracted from a complete
  package; no observed whole-package resolution closure or executable plan exists.
  Durable append-only journaling, attempts and idempotency remain unfinished.
- All 11 original RequiredAuthorities remain missing: `archive_intake`,
  `complete_package_schema`, `canonical_source_and_property_provenance`,
  `fsusui_syntax_dependencies`, `persisted_relation_and_embed_plan`,
  `frozen_public_projection_retention`, `asset_and_dependency_resolution`,
  `rights_responsibility_taxonomy_privacy`, `current_actor_site_target_permissions`,
  `current_target_revision_and_identity`, `execution_qualification`.
- The exact donor planner still returns false with
  `article_package_import_authority_unavailable` from RequireExecutionAuthority;
  the proposal delegates to it. ExecuteDisabled is always true and
  HasObservedResolution is always false. Finite-byte validation never supplies
  these missing authorities. No runtime zero-write observation is claimed.

## Actual candidate static checks

These results apply to the real source composition `d7eb15bae54ceac5f72f5051ce4e8759177e89ae`
in `/workspace/FsusBlog-resolution`, not a temporary dependency diagnostic.

- Locked restore of the original complete Server project: PASS exit 0.
- Original complete Server build: PASS exit 0, **330 warnings, 0 errors**. Full
  compiler warning multiset added 0, removed 0 against clean exact #4335 after
  only actual worktree-root/source-position normalization. No warning is waived.
- Original strict C# checker across all 17 added source leaves: PASS exit 0,
  files=17, violations=0, new=0. Donor bytes are not reformatted or patched.
- Original authoritative development-docs check: FAIL exit 1, same 41 baseline
  diagnostics; complete base/candidate output byte-identical.
- Original code-intent check: FAIL exit 1, same two baseline diagnostic lines in
  `authoringCanvasSpatialIndex.ts` and `font_theme_admin_pods.hpp`. Checked files
  increase from 5714 to 5731 only for the 17 added source leaves.
- All 14 donor blobs/SHA-256 values match; all original three source blobs are
  unchanged; every pre-existing source blob/mode matches base. All 11 excluded
  input paths remain absent. Staged/range diff and commit-message checks pass.
- Actual final REST PR metadata, precise base/head and draft state are read back
  in delivery. Missing remote checks are not reported as PASS.

The projects, source inclusion, references, analyzers, configuration, warning rules,
security settings, lockfiles and dependency configuration are unchanged. Static
compilation never runs its output. No reduced project, fake dependency, suppression
or qualification producer is used.

Tool environment: SDK 10.0.401 via `/workspace/.setup/dotnet`, task CLI home
`/tmp/article-resolution-dotnet`, existing NuGet cache `/workspace/.setup/nuget`.

```bash
dotnet restore src/backend/FsusBlog.Server.csproj --locked-mode
dotnet build src/backend/FsusBlog.Server.csproj --no-restore --nologo -v:minimal
node tools/docs/check-authoritative-development-docs.mjs
node tools/governance/check-code-intent.mjs
```

The original strict checker command is `node tools/dotnet/check-csharp-style.mjs
--mode strict-full` with one `--file` argument for every one of the 17 source paths.
The complete exact command is retained in the local logs directory below.

## Prior failures retained

- Prior actual three-file candidate at `a4368e3869d956a06ca7e589c9ad965198b73b36`
  failed complete Server compilation with 22 missing-type errors. This was a real
  integration blocker, now resolved in actual source by the authorized 14-file
  prerequisite intake; it is not rewritten as a historical PASS.
- The earlier private exact-base +25-input diagnostic passed with 330 warnings/
  0 errors but was not candidate acceptance. The 25-file set was not minimal;
  this intake excludes the four specified and seven additional unnecessary files.
- The earlier whole #4155 +4012 mapper diagnostic failed with 344 warnings and one
  missing ArticlePropertyValueValidator error. Raw failure remains retained.
- Initial actual PR metadata failed until the existing broad managed-path external
  naming declaration was added. That declaration is now extended to the exact 17
  source paths under the unchanged trusted-base `environment-variable` registry.
  No process environment key, naming rule or execution authority is introduced.

## Remaining work and HOLD

The compile prerequisite gap is closed only for this bounded ordinary source
candidate. Independent source review and all original #2404/#2413 acceptance union
remain open: actual canonical mapping/creation observations, exact owner schemas/
options/constraints, rights/permissions/lifecycle/current-store drift, asset/link/
anchor resolution, complete unresolved extraction, immutable executable replan,
durable journal/idempotency, independent verifier and static mutation controls.
No original issue criterion is waived by the other issue or by this compile PASS.

All runtime, tests/test collection/discovery, product-module import execution,
DB/native/browser, frozen receipt/catalog/fixture generation, qualifications and
canonical creation remain HOLD/UNRUN. No route or production activation, issuer,
reader, executor, grant, merge, Ready, issue closure, publication or deployment.

Rollback: omit/revert only this PR's 17 added C# leaves, ordinary WIP and static
naming declaration; no existing source, live data or physical schema was modified.

## Raw static logs

Current full logs are retained under `/tmp/article-resolution-closure-checks/` in
the shared environment, with the complete strict checker command and static
provenance/necessity scratch records. These are diagnostics, not product receipts.
The earlier failures remain under `/tmp/article-resolution-checks/` and the prior
WIP copy is `/tmp/article-resolution-closure-checks/prior-wip-a4368e386.md`.

SHA-256 of completed current raw checks:

- `candidate-restore.log`: `40d104602671164ab3958225da3e1c8cabd55f0251d6df6bc911d9d5a24f44ce`
- `candidate-build.log`: `42b2e5b4b0a48bde90f83ecfa578614c2cf22e6092c0d7d04014494bf3b4813c`
- `style-command.txt`: `4da659de47a855827f78accf555fb563390a48d986ea4f2b9acdb2c86d353fde`
- `style.log`: `f918f62a9fbd5c15c545333f4fc80c78a98158edd194aacd6ac4c17127369cc3`
- `docs.log`: `7ef7c37f2d494d72fcc2ae562ad45efee5044fa9ff83037812499955ee214403`
- `intent.log`: `324688546113a4afa91a137f590c4f80dda043974668a649ce9c1022dcd00cc6`
