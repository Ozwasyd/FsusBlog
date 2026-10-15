# Revision content source WIP

Ordinary source handoff for open issue #1775. Issue #1762 remains tracking only. This file is not execution authority, a frozen receipt, schema catalog, fixture, qualification or physical retirement evidence.

## Candidate and scope

- Original saved checkout: `/workspace/FsusBlog`, clean `work` at `29051db2a80db7770dfe78a1db6e4c6998337324`; real shell is Bash.
- Exact direct base: `1016c633466fb18083a8ac0f6cc56e9bb448b99f`, draft #4335, branch `codex/issue-2295-seven-reviewed-source-composition-20261014`.
- Source checkpoint: `c9e0817843b4a3919d258554d049690b337f5ac5`; final PR metadata HEAD is reported by the PR, after this handoff commit.
- Independent branch: `codex/issue-1775-revision-content-source-20261015`.
- Exactly nine authorized production C# paths plus ordinary naming metadata in the source checkpoint. This later commit adds only this ordinary WIP.
- `Article.cs` is byte-identical to the base. The old mapped property remains because its prohibited and out-of-scope dependencies are still present; no ignored, shadow or replacement mapping was introduced.
- Reference heads were fetched and verified exactly: #4295 `1aef629210615835bd05e1aaa88d3ab231cef1cd`, #4286 `9cef836ca041bd74eb6baa4c245bffb0b11bb200`, #4269 `d3803f2f63dab20d0dd31bc7c7809d191320cb79`. They concern bulk/auth source owners and were inspected without importing their deltas or histories into this increment.

## Scoped source behavior

`LoadAsync` rejects nonpositive block IDs before querying and retains the existing missing-block failure. `HydrateAsync` rejects invalid IDs before its existing single batched content-block query, validates every requested reference, and returns the content-by-block-ID table without mutating revision entities. Missing blocks and NULL content refuse; an existing block containing an empty string remains valid. The returned table is ordinary operation-local content, with no authority or lifetime claim.

Revision detail, rollback, mutation side effects and integrity proof inputs receive explicitly loaded strings. Integrity's private loader carries `(Revision, Content)`; the canonical proof input and external DTO names remain unchanged. Revision summaries retain their existing reachability check.

Single-article and bulk backup export consume the returned block table. Imported revisions retain the original ordering, normalization, metadata, transaction and block-dedup owner; a tuple holds normalized content outside the entity until block creation. The two scoped ORM revision inserts explicitly ignore the legacy column. This does not remove the mapping from other ORM projections or prevent the existing database default from populating a surviving column.

Search, AOT and hot-artifact projections select only content-block Markdown for their content field, retaining their existing LEFT JOINs and all publication/category/body conditions. Each projects the expected positive block ID and actual nullable joined block ID, and refuses unresolved coordinates before body-repair skipping, summary fallback or projection consumption. Search uses an anonymous SQL row followed by its existing read model so the model's default empty string cannot conceal a missing joined block. No extra join or per-revision database round trip was added. Database execution and query translation are UNRUN.

The content-block hash/upsert SQL, UTF-8 source-byte rules, collision handling, dedup algorithm, revision history and public DTO/AEDS declarations are unchanged. No measurements or behavioral equivalence are claimed from compilation.

## Actual static checks

Original SDK `10.0.401`, Node `v24.19.0`; the SDK is `/workspace/.setup/dotnet`. Only PATH, original CLI home and original NuGet cache locations were supplied. No rules, project/configuration, references, analyzers, lockfiles, thresholds, warning policy or security setting was changed.

| Check | Result |
| --- | --- |
| Original full Server locked restore, baseline and candidate | Exit 0 / 0. |
| Original complete Server static build, clean baseline | Exit 0, 330 warnings, 0 errors. |
| Original complete Server static rebuild, candidate | Exit 0, 330 warnings, 0 errors; `--no-incremental` rebuilds the complete original dependency closure. |
| Complete compiler diagnostics with multiplicity | 660 emitted diagnostic lines on each side, added 0 / removed 0 after replacing only actual worktree roots and line/column coordinates. Summary duplication is retained. |
| Original strict C# lint on all nine changed production paths | Exit 0, `files=9 violations=0 new=0`; original folder whitespace and solution-style commands retained. |
| Original complete C# lint | Both exit 1; 552 diagnostic lines, byte-identical logs. FAIL remains FAIL. |
| Original complete code-intent lint | Both exit 1; same two errors across 5714 checked files, byte-identical logs. FAIL remains FAIL. |
| Git whitespace and source commit message/title | Exit 0. Final range and actual PR metadata checks are reported in the PR. |

Commands (from the corresponding unmodified base worktree or candidate checkout):

```sh
dotnet restore src/backend/FsusBlog.Server.csproj --locked-mode
dotnet build src/backend/FsusBlog.Server.csproj --no-restore --nologo -v:minimal
dotnet build src/backend/FsusBlog.Server.csproj --no-restore --no-incremental --nologo -v:minimal
node tools/dotnet/check-csharp-style.mjs --mode strict-full --file src/backend/Services/Articles/ArticleRevisionContentBlockStore.cs --file src/backend/Services/SearchIndexService.RuntimePersistence.cs --file src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs --file src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs --file src/backend/Services/ArticleMutationSideEffects.cs --file src/backend/Services/Authoring/AuthoringDraftLifecycleService.cs --file src/backend/Services/Authoring/AuthoringContentTransferService.cs --file src/backend/Infrastructure/Integrity/IntegrityProofPipeline.cs --file src/backend/Services/Authoring/PostgresArticleCreatePersistence.cs
node tools/dotnet/check-csharp-style.mjs --mode full
node tools/governance/check-code-intent.mjs
git diff --check
```

The clean baseline was built at `/workspace/issue-1775-base`, detached at the exact base, with no tracked changes. An earlier build overlapped source editing and is discarded as baseline evidence. An initial candidate incremental build reported 139 warnings because unchanged dependencies were not rebuilt; it is not the complete comparison above. Initial strict selection including unchanged `Article.cs` failed its pre-existing using-order diagnostic; the temporary comment edit was removed, and the final nine-path scope excludes that unchanged file. No import reordering sweep or lint rule was used to remove the failure.

Full C# lint retains existing violations throughout other source/test files. Code-intent retains the existing performance-wording findings in `authoringCanvasSpatialIndex.ts` and `font_theme_admin_pods.hpp`. Source lint reads text; no test, test collection or product module was executed. No frontend changes, frontend compile, migration invocation or runtime acceptance is claimed.

Raw logs and the ordinary comparison text remain at `/workspace/FsusBlog/.tmp/issue-1775/`. Canonical comparison inputs are `clean-baseline-server-build.log`, `candidate-complete-server-build.log`, `clean-baseline-full-style.log`, `candidate-full-style.log`, `clean-baseline-intent.log` and `candidate-intent.log`; `candidate-final-style.log` records the strict check. These are task-local diagnostics, not execution receipts.

## Remaining blockers

1. `src/backend/Services/Fixtures/PublicContentFixtureSeeder.cs` still assigns `revision.MarkdownContent` and includes it in `UpdateColumns`. This file was explicitly prohibited from modification.
2. `CanonicalArticleLifecycleFixturePort.cs` and `CanonicalArticleLifecycleVerifier.cs` include `item.MarkdownContent` in their original timeline digest. Tests also construct revisions using the old property. These source/fixture semantics were preserved; their owners must reconcile them without hand-generated observations or receipts.
3. Out-of-scope `src/backend/Services/Articles/ArticleRevisionPersistence.cs` still explicitly inserts `article_revision.markdown_content` as an empty string in raw SQL. The source cannot be described as having no legacy writes.
4. Out-of-scope `src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs` still selects `revision.markdown_content` for rights-recompute candidates. Its old-body fallback is unchanged. The source cannot be described as having no legacy reads.
5. The original `ArticleRevision.MarkdownContent` ORM mapping therefore remains. Generic entity projections still include the old column. Removing it while preserving these sources would break compilation and/or leave unresolved SQL dependencies; adding an ignored carrier would conceal the unresolved ownership boundary. This PR does neither.
6. The migration owner, frozen schema/model and schema admission remain untouched. Physical reachability/hash verification, legacy backfill, dedup verification, column drop and rerun/idempotency are all HOLD/UNRUN. No startup/schema qualification was established.

Future permitted verification must cover invalid/nonpositive and dangling block references with populated old Markdown, a real empty block, shared blocks across revisions/articles, null block content, all three projections, detail/rollback/export/backup/integrity/side-effect consumers, and both import/create writes. These are pending verification obligations, not tests created or run here.

## HOLD and rollback

All runtime execution, tests and discovery/collection, product module import execution, database/native/browser work, physical backfill/drop, frozen model/catalog/fixture/receipt generation and qualification remain HOLD/UNRUN. No safety settings were changed, no authority fabricated, and no merge, Ready, issue closure or package publication was performed. #1775 remains incomplete and #1762 receives no separate implementation PR.

Review only the bounded increment against the pinned base. If the source change is unsuitable, revert or omit only these nine source paths and the ordinary task metadata. No live data or schema was changed. Activation requires the remaining original owners and independent review; static compilation cannot authorize physical retirement or production deployment.

## Source identities

- `src/backend/Infrastructure/Integrity/IntegrityProofPipeline.cs`: blob `2625645449dcbb9e3eff6b95d9ffb829787af594`, SHA-256 `fd2de033cd19873ee1f20a37ba8aab2780f1168e385cbbcdc0546a220d321012`.
- `src/backend/Infrastructure/PublicAot/PublicAotBootstrapProviders.cs`: blob `8779a8cb222d7a99f66f0ff3d149ee9830fd27e6`, SHA-256 `58bc21a5214e2154edba8768f2ac0e34da1b84e6479ed5402456a621f2e8a405`.
- `src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs`: blob `5fd4898232aa1c427484ab4830a54c4bcd050695`, SHA-256 `dbe14eab0994ac79c5f2a172ad6632d39a458978201974dbb2a9e5ea3f3b4174`.
- `src/backend/Services/ArticleMutationSideEffects.cs`: blob `1972f1cdfda60a5a3b0429b1adf310a2c7a5973c`, SHA-256 `5e5cf223e5a84057f30ab07bc9d100ee83efb893f32d96ca7636cde1618979a1`.
- `src/backend/Services/Articles/ArticleRevisionContentBlockStore.cs`: blob `cd470e440979b323692c90b6b0c935d3a7986d9f`, SHA-256 `81ce7b9a70f522811517136ed0cca0ac54584e0f1eedb5930943b8604e3060c4`.
- `src/backend/Services/Authoring/AuthoringContentTransferService.cs`: blob `bdf83936d024b588e23be85470e4c313932b9cc1`, SHA-256 `cb55937bca0884841111382c6e30c4b73f5dc346045ed136082639e13ee55312`.
- `src/backend/Services/Authoring/AuthoringDraftLifecycleService.cs`: blob `066e5c3a1cbfd02ff2eb76aa2cfc4cf03ebe850b`, SHA-256 `3a6b6bef2afbb5901884c7add06dda3e15774ca28fa4921d3ac60d682bd3e259`.
- `src/backend/Services/Authoring/PostgresArticleCreatePersistence.cs`: blob `6e3d4b8be856d5d96c17777d904a76c71f998c29`, SHA-256 `8af9d94389e75b2dff68828476eda0c6e39f00c0b088d9a6cfa709b213a475dc`.
- `src/backend/Services/SearchIndexService.RuntimePersistence.cs`: blob `d5b3ce7b80dd0be26f4838c4cd6cbdc7d3e41c93`, SHA-256 `360b9a6bfc5cf8563703abd3551543ce67b984eeff197f490c696d54685b6323`.
