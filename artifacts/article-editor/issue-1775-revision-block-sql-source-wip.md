# Revision block SQL source WIP

Ordinary handoff for the next authorized source batch of open issue #1775. #1762 remains tracking only. This document is not a frozen receipt, schema catalog, fixture, execution authority, independent acceptance or qualification.

## Exact candidate

- Exact direct base: `dafc318bea617a3de87fd9525110c26c4a3c7070`, draft #4341, branch `codex/issue-1775-revision-content-source-20261015`.
- Production source checkpoint: `fb661a88ba55f1a5de5200b403765f41a5ac9262`. A later handoff-only commit supplies the final PR head.
- Independent branch: `codex/issue-1775-revision-block-sql-source-20261015`.
- Real shell/cwd verified: Bash, `/workspace/FsusBlog`. Original checkout was clean at the exact base. The independent clean baseline is `/workspace/issue-1775-sql-base`, detached at that same SHA.
- The eight requested C# paths plus one necessary same-owner partial file are changed. `ArticleService.AuthoringCanvasLink.cs` contains the actual Undo caller's `ReadCanvasLinkRevisionSourceAsync`; retaining its old SQL fallback would leave that path open after changing `LoadArticleUpdateStateAsync`. Only its body source projection and missing-block guard were changed, retaining the existing error code and transaction/admission call path.
- Ordinary external-naming metadata covers exactly those nine managed paths under the original broad registry. No policy or registry was changed. This later commit adds only this WIP.
- The prior #4341 source and WIP are preserved as the base. `Article.cs` is unchanged; its legacy ORM mapping is deliberately retained under the caller's explicit boundary.

## Final source behavior

| Owner | Change and preserved boundary |
| --- | --- |
| `ArticleRevisionPersistence` | Omit the legacy revision column and its empty-string value from the original insert. Preserve the original independent block upsert, hash encoding, advisory/article locks, revision number allocation, conflict retry, transaction owner, parameters and returned IDs. A surviving database default may still populate a surviving column; no physical retirement is implied. |
| `ArticleDetailAedsArtifactStore` | Rights-recompute candidates retain the exact latest-revision ordering, paging and policy/snapshot selection. Replace the old Markdown/body fallback with the chosen revision's block. Project and check positive expected/resolved block IDs and non-NULL content before constructing candidates or computing their original canonical digest. The normal published AEDS path still uses its original materialized `article_body` contract; this increment does not change that separate projection. |
| `ArticleService` | Private and public revision body selection uses the corresponding immutable block. Remove the private body/legacy-text COALESCE and old column GROUP BY terms. Validate positive selected revision/revision number, expected revision, positive expected block, resolved block and non-NULL content before materialization/cache work. Article ownership is included in revision/publication joins. Original visibility, public publication selection, tag/rights selection, cache boundaries, timestamps and public empty-body presentation rules remain. A valid empty draft block still yields an empty string. |
| `ArticleService.Mutations` | Read the current revision's actual block without legacy fallback. A LEFT JOIN retains an existing article with missing/foreign revision long enough to refuse it instead of treating it as absent. Validate revision/block coordinates and non-NULL content before no-change comparison or mutation state use. Existing article/deleted predicates, metadata/tag/xmin inputs and caller transaction/lock flow remain. |
| `ArticleLifecycleTransitionWriter` | Source reconstruction reads only block Markdown; missing requested revision retains its original not-found validation. An unresolved block refuses. Audit content digest uses one explicit revision/block read, refuses absent revision/block/content, and passes the exact string to the unchanged UTF-8 digest owner. No fallback-to-empty digest remains. All original permission, publication, locking, audit/outbox and transition callers remain. |
| `PostgresAuthoringCanvasCoordinateAuthority` | Keep original principal/article access filtering, pinned/current revision selection, borrowed connection/transaction and sequential text scan. Read expected block ID and actual block ID before the last text column. Missing/invalid/NULL blocks produce no facts, preserving the resolver's original fail-closed absent-fact handling; never scan old Markdown or invent a current coordinate. Stream ordinal changes from 2 to 4 to match the new projection. |
| `ArticleBodyRepairWorker` | Original published/current-publication/current-revision/article ownership restrictions now select block content for the materialized body. Missing/NULL/blank block content cannot repair. If the insert reports no change, the original follow-up count must resolve the same publication/revision/block and find a body matching block content; a merely nonempty surviving body is insufficient. Existing empty-only conflict update, bounded retry queue, unresolved return and invalidation/rebuild sequence remain. The existing positive-insert short circuit and separate statement boundaries remain; no new atomicity or cross-statement race guarantee is claimed. |
| `AdminIntegrityOperations` | Compare the original published nonempty body's content with the current revision's block, and report invalid/missing block coordinates or NULL block content. Preserve original scope/status predicates, issue code, sample/count machinery, confirmation, safe-fix selection and manual-review classification. No automatic body overwrite was added. |
| `ArticleService.AuthoringCanvasLink` | Undo source reads the exact requested article/revision's block and checks positive/matching block coordinates and non-NULL content. Retain `article_canvas_link_revision_unavailable`, summary handling, existing transaction/locks and all Apply/Undo permission/history/stale-coordinate checks. |

No content trimming, re-encoding, canonicalization, hash algorithm change or reconstructed Markdown is introduced. Existing blank-body checks still use their original `btrim`/presentation semantics while read/hash/write input strings remain unchanged. Block dedup implementation, public DTO/AEDS declarations and fixture timeline digests are byte-identical to the base.

## Actual complete static verification

Tools: original SDK `10.0.401` at `/workspace/.setup/dotnet`, Node `v24.19.0`. Only PATH and the existing CLI home/NuGet cache locations were supplied. Original project, configuration, references, analyzers, restore lock mode, warning policy and complete scope were retained. No alternate project, reduced configuration, suppression or threshold change was used.

| Check | Exact base versus final source |
| --- | --- |
| Original Server locked restore | Exit 0 / 0. |
| Original complete Server rebuild with original dependency closure | Exit 0 / 0, 330 warnings and 0 errors on both sides. Both use `--no-incremental`, not an incremental warning count. |
| Complete compiler diagnostic multiset | 660 emitted lines each, added 0 / removed 0 after only worktree-root and source-location normalization; repeated summary lines retain their original multiplicity. |
| Original strict C# check on all nine changed paths | Exit 1 / 1, same four failures after location normalization; added 0 / removed 0. Original folder-whitespace and solution-style commands retained. |
| Original full C# check | Exit 1 / 1, 552 lines each, added 0 / removed 0 after source-location normalization. This is FAIL, not an accepted baseline waiver. |
| Original full code-intent check | Exit 1 / 1, two errors across 5714 checked files, byte-identical three-line logs. |
| Git whitespace, source commit message/title and exact scope preservation | Exit 0. Final range and actual REST PR metadata are reported in the PR after handoff publication. |

Strict failures are the two pre-existing import-order findings in `ArticleService.AuthoringCanvasLink.cs`, the pre-existing registered IDE1006 declaration mismatch in `ArticleService.cs`, and the pre-existing import-order finding in `PostgresAuthoringCanvasCoordinateAuthority.cs`. The new `Infrastructure.Data` using moves the existing ArticleService diagnostic from line 46 to 47; its full text is otherwise unchanged. No unrelated import sweep or validation-policy modification was made. Code-intent still rejects the existing performance-wording claims in `authoringCanvasSpatialIndex.ts` and `font_theme_admin_pods.hpp`.

```sh
dotnet restore src/backend/FsusBlog.Server.csproj --locked-mode
dotnet build src/backend/FsusBlog.Server.csproj --no-restore --no-incremental --nologo -v:minimal
node tools/dotnet/check-csharp-style.mjs --mode strict-full --file src/backend/Services/Articles/ArticleRevisionPersistence.cs --file src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs --file src/backend/Services/ArticleService.cs --file src/backend/Services/ArticleService.Mutations.cs --file src/backend/Services/Articles/ArticleLifecycleTransitionWriter.cs --file src/backend/Services/Authoring/PostgresAuthoringCanvasCoordinateAuthority.cs --file src/backend/Services/Background/ArticleBodyRepairWorker.cs --file src/backend/Infrastructure/Operations/AdminIntegrityOperations.cs --file src/backend/Services/ArticleService.AuthoringCanvasLink.cs
node tools/dotnet/check-csharp-style.mjs --mode full
node tools/governance/check-code-intent.mjs
git diff --check
```

Raw diagnostics are retained in `/workspace/FsusBlog/.tmp/issue-1775-sql/`: `base-restore.log`, `candidate-restore.log`, `base-build.log`, `candidate-final-build.log`, `base-final-strict-style.log`, `candidate-final-strict-style.log`, `base-full-style.log`, `candidate-final-full-style.log`, `base-intent.log`, `candidate-final-intent.log`, `comparison.txt` and `compiled-source-bytes.txt`. These are ordinary task diagnostics, not canonical receipts. Earlier eight-path checks/builds are retained separately; the final candidate checks include the necessary ninth Undo source file. No compiled product, test module or runtime helper was executed.

## Preserved and remaining owners

- `Article.cs` still maps the old column. Generic ORM revision reads therefore still project it. This batch does not claim complete current-schema/source retirement.
- `PublicContentFixtureSeeder`, `DemoFixtureSeeder`, lifecycle fixture/timeline owners, tests and frozen producers remain unchanged. Fixture raw inserts and old property constructions/digests still require their original owners.
- All nine production files are free of references to `revision.markdown_content`, `current_revision.markdown_content`, `published_revision.markdown_content` and `r.markdown_content`; the scoped revision insert does not name the old column. This is a bounded source inspection, not a schema/catalog or whole-system SQL qualification claim.
- Existing materialized `article_body` creation/update, normal public AEDS body admission and other projection contracts remain. They must not be confused with legacy inline revision Markdown.
- Physical backfill, content hash/dedup verification, reachability observations, drop/idempotency, current schema/frozen target generation, startup and migration execution remain HOLD. No `ArticlePreservationStorageProgram` or other migration owner was edited or invoked.
- Real SQL preparation/translation/GROUP BY semantics, collation, database concurrency, source/stream borrowing, auth, publication, digest parity, repair and cleanup behavior are UNRUN. Source compilation is not acceptance of those behaviors.
- Pending behavioral verification includes missing/nonpositive/foreign revision coordinates, missing/nonpositive/dangling blocks with populated legacy text or nonempty materialized body, NULL versus empty real block content, shared blocks, exact non-ASCII/line-ending bytes and digest parity, Undo, permission-denied/pinned Canvas facts, publication drift and no-change repair conditions. These are handoff obligations, not tests run or generated here.

## HOLD, delivery and rollback

This batch preserves the explicit runtime/tests/collection/discovery/native/browser/DB/frozen/fixture/catalog/receipt/qualification HOLD. No rule, security setting, canonical producer output or authority was changed or fabricated. #1775 remains open/incomplete; #1762 receives no implementation PR. Independent parent review is still required for this new candidate; the prior batch's limited source acceptance is not reused as acceptance of this one.

Review the new draft's direct increment on exact #4341. Revert or omit only these nine source files and ordinary task metadata if block ownership, visibility, coordinate, digest or repair semantics are unsuitable. No live data/schema was changed. No merge, Ready, closure, dispatch, release/package publication or runtime activation is authorized by these static results.

## Production source identities

- `src/backend/Infrastructure/Operations/AdminIntegrityOperations.cs`: blob `5dcaedc4a3a295038cb27d0b629879741a4431e1`, SHA-256 `a8e53cde2cce1107ee2495c3cece73ef6276bf7c43cb44a41988d29dbd18f41d`.
- `src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs`: blob `43e2ab8495f12d7e1406f03d37b6030f30140678`, SHA-256 `6a7c12f40a1255fbd2c58d5742fae1924cdcda11093f8cdb3346fd6f571f3f2e`.
- `src/backend/Services/ArticleService.AuthoringCanvasLink.cs`: blob `f95192b6ae0929ea2baa7e096bf9ec22beae85f6`, SHA-256 `7735f072d0b543f85a7ebce675f9e4ea39e10a4559f6c9ab2efbd70a525709fe`.
- `src/backend/Services/ArticleService.Mutations.cs`: blob `91398e92a3bb0a81f81ba600bf6223746c79b4be`, SHA-256 `221fd7eaf0d101e95e9500b6e10f71aa008a45aae6496a118db17e3153752cac`.
- `src/backend/Services/ArticleService.cs`: blob `d10b056593432404b5ff5ffc0a3123347005392d`, SHA-256 `064585065a095f108d1f252307def5dd580cafcdc56cbc1366ebfde5149e74d5`.
- `src/backend/Services/Articles/ArticleLifecycleTransitionWriter.cs`: blob `f6e03a8597f1a03df3d303d71538f896fc9ae452`, SHA-256 `2297650a768165dc97dacf86821b712ab1f9f7187d0c51c458e3be9867f81ba1`.
- `src/backend/Services/Articles/ArticleRevisionPersistence.cs`: blob `8ac83565c432764af192c9e81ae05c5c25bb3eef`, SHA-256 `b2221590feb654133c9a5368f497ae9e090b5c7f2395181e2a09a7bf81469041`.
- `src/backend/Services/Authoring/PostgresAuthoringCanvasCoordinateAuthority.cs`: blob `5f55c9c81ac2b6ed6999b3cff745b3a12d9deadb`, SHA-256 `661a514874743b753f16a9645429602636d735d9874a71e4ec698c0968d234fa`.
- `src/backend/Services/Background/ArticleBodyRepairWorker.cs`: blob `561e3be361f286c6db14bbc37e1ed88c6b80eadc`, SHA-256 `66f1c36ada90e119ea4360c154f7024684cca2560b32a9b29b030363779bd3b4`.
