# Article embed refresh plan source WIP

This ordinary source handoff concerns open issue #2467 (original #2246 -> #2458). It is not an execution, authorization, persisted receipt or qualification artifact.

## Exact scope and ownership

- Direct base: Main draft #4335, `1016c633466fb18083a8ac0f6cc56e9bb448b99f`.
- Branch: `codex/issue-2467-nonexecuting-refresh-plan`.
- Exclusive implementation takeover from terminated task `01a13b6b-ccc3-77c0-a935-bff98eabb01d`; no replacement author was started.
- Exactly three new implementation files: `ArticleEmbedRefreshPlanContracts.cs`, `ArticleEmbedRefreshPlanner.cs` in shared `Contracts/ArticleEmbeds/Authoring/`, and backend `Services/Authoring/ArticleEmbedRefreshPreparation.cs`.
- One current API explanation and this ordinary WIP plus required naming metadata. No pre-existing source, configuration, lockfile, fixtures, test source, schema, runtime registration or authority output changes.

## Implemented candidate

The request binds an explicit 1..256 occurrence selection, actor/site/permission context, exact host draft key/server expected revision/document epoch/source revision and digest, previously observed host facts digest and current authority generation/digest. Host facts require an ordered, non-overlapping complete roster of up to 4096 recorded dependency occurrences; the caller must establish its provenance and completeness. Structural hashing cannot establish either.

Each selection supplies the original sealed authoring provider request, parser-owned directive identity/range/token/mode and exact recorded/desired dependency coordinates. Duplicate directives/request IDs, mismatched old facts, wrong target mode/identity and host/actor/source/runtime drift refuse. No target fallback, Markdown parsing, implicit all/latest selection, target mutation, display content copy or publication path is introduced.

The planner is written against the existing `ArticleEmbedAuthoringPipeline.Evaluate` (Resolver -> DependencyGraphPlanner -> RelationDeriver), `ArticleEmbedDependencyGraphVerifier` and `ArticleEmbedAuthoringRefreshPolicy.TryCompare`. The latter remains the sole compare owner; its boolean is expanded into immutable bound plan data, not treated as execution permission. Target/permission/kind/anchor/cycle/budget failures refuse the whole explicit set, without a partial plan. Host/authority/desired coordinate and reachable target observation drift return Stale; an unchanged set returns NoChange; cancellation returns no plan. Pipeline graph evaluation covers only selected current targets. It does not certify unselected persisted host graph safety.

The candidate plan has no public constructor/setters and retains only immutable arrays of sealed immutable coordinate/directive records and metadata. It freezes request/host/actor/source, exact old/new coordinates, target source digests, observed permission/lifecycle, runtime/material context, selected graph topology, relation/graph digests and closed budgets/observations under the shared canonical digest writer. It has no target source, attribution display text, publication artifact, database row or cancellation token. `CanExecute` is always false.

Backend preparation is a static, unregistered facade requiring observations as arguments. It supplies no reader, permission authority, DB transaction, endpoint or DI registration; missing real host facts block. Its execution-capability list explicitly retains missing canonical host dependency read, current host/target permission and whole-host graph revalidation, expected-revision CAS/idempotency, and canonical no-source-change draft revision/outbox/audit commit. A caller supplying a structural record does not satisfy those capabilities.

## Missing prerequisite source closure

Inspection of the actual #4335 tree found neither RefreshPolicy nor Pipeline nor Graph namespace. Its resolver/verifier still combine projection and recursion. Reusing the referenced split owner therefore requires a separate eight-file prerequisite source decision, not three new files silently layered on unavailable APIs.

Exact candidate prerequisite donor: #3958 `ab713219ea9b2be99061bd325039e8f4b67aca42`:

1. `src/shared/Contracts/ArticleEmbeds/Authoring/ArticleEmbedAuthoringPipeline.cs` (new).
2. `src/shared/Contracts/ArticleEmbeds/Authoring/ArticleEmbedAuthoringRefreshPolicy.cs` (new).
3. `src/shared/Contracts/ArticleEmbeds/Authoring/ArticleEmbedAuthoringResolver.cs` (existing owner modified).
4. `src/shared/Contracts/ArticleEmbeds/Authoring/ArticleEmbedAuthoringVerifier.cs` (existing owner modified).
5. `src/shared/Contracts/ArticleEmbeds/Graph/ArticleEmbedDependencyGraphPlanner.cs` (new).
6. `src/shared/Contracts/ArticleEmbeds/Graph/ArticleEmbedDependencyGraphVerifier.cs` (new).
7. `src/shared/Contracts/ArticleEmbeds/Relations/ArticleEmbedRelationDeriver.cs` (route existing derivation verification to graph owner).
8. `src/shared/Contracts/ArticleEmbeds/Relations/ArticleEmbedRelationVerifier.cs` (route existing relation verification to graph owner).

Static diff of that exact eight-file set against the base is 1104 insertions, 421 deletions. No donor files or history have been imported. Reference #3953 `8c239073c3a7f602b43f27264aa22bee33a6d334` and #4162 `cdf46ba5934f3d068c0018dc8ef3551223dcfb7d` were inspected as source context only; their test/runtime evidence is not reused. A scope question about the separate prerequisite import remains unanswered. Compilation must stay reported as blocked until the original owner admits that closure or provides an exact compatible composition base. Do not make a local replacement policy/graph/authority to avoid the gap.

## Static verification

Raw diagnostic logs are retained at `/tmp/issue-2467-static/` in this selected container. Those logs are local diagnostics, not canonical receipts or portable acceptance.

- Three-file complete original Server build: `dotnet build src/backend/FsusBlog.Server.csproj --no-restore --nologo -v:minimal` actually exits 1, CS0234: missing `FsusBlog.Shared.Contracts.ArticleEmbeds.Graph`. That blocks semantic compilation; no source behavior is claimed executed.
- Original strict C# checker including its original folder whitespace and solution style commands: `node tools/dotnet/check-csharp-style.mjs --mode strict-full --file src/shared/Contracts/ArticleEmbeds/Authoring/ArticleEmbedRefreshPlanContracts.cs --file src/shared/Contracts/ArticleEmbeds/Authoring/ArticleEmbedRefreshPlanner.cs --file src/backend/Services/Authoring/ArticleEmbedRefreshPreparation.cs` exits 0, 3 files/0 violations. The first run failed whitespace and one Allman-brace finding; those new-file formatting defects were repaired and the failure log is retained.
- SDK is the existing 10.0.401 installation, Node is 24.19.0. Only SDK PATH, task-local CLI home and existing NuGet cache are selected; no build property, warning policy, project/reference graph, lockfile or checker is changed.
- An isolated, tracked-clean checkout `/workspace/issue-2467-base-static` at exact `1016c633466fb18083a8ac0f6cc56e9bb448b99f` completed original `dotnet restore src/backend/FsusBlog.Server.csproj --locked-mode --nologo` and the same full Server build, both exit 0, with 330 warnings/0 errors. No candidate files are present in that checkout. An earlier pre-planner build in the working checkout also succeeded, but the isolated exact-base run is the comparison evidence.
- Complete original `node tools/dotnet/check-csharp-style.mjs --mode full` remains FAIL1 on base and candidate: 552 diagnostic lines, identical after exact checkout-root normalization; no new-path findings. This does not waive whole-project style debt.
- Complete original `node tools/governance/check-code-intent.mjs` remains FAIL1 on both: the same two existing frontend performance-wording errors. Only its checked-file count changes 5714 -> 5717 for the three new C# files.
- Original `node tools/docs/generate-document-lifecycle.mjs --check` remains FAIL1/FAIL1 with the same 7 lines; `node tools/docs/check-authoritative-development-docs.mjs` remains FAIL1/FAIL1 with the same 41 lines. Full logs are identical after checkout-root normalization. No document lifecycle/index/catalog was regenerated.
- Required-tool native document lint initially exits 1 because `markdownlint-cli2` is missing. That failure is retained. Installing only `markdownlint-cli2@0.23.1` under `/tmp/issue-2467-tools` with lifecycle scripts disabled, then rerunning original `./tools/lint.sh docs --require-tools --file docs/api/contracts.md` gives FAIL1/FAIL1, 26 existing findings on base/candidate. Complete diagnostic text is identical after line-number-only normalization; added paragraph shifts later locations by 16 lines. The native checker excludes ordinary artifacts under its existing policy; its checked document count is 1, not the WIP or naming manifest. No rule or exclusion was changed.
- Naming metadata parses as JSON; Git whitespace checking passes. Commit-range and actual PR metadata checks are completed against the committed source and read-back PR below/in the final handoff.

## Execution and acceptance remain HOLD

All runtime, tests, collection/discovery/list, product/import execution, database, native/browser, frozen receipt/schema/catalog fixture generation and qualification are HOLD/UNRUN. No refresh/planner/pipeline method, compiled assembly, product endpoint, source generator authority producer, DB/catalog/preflight or import helper has been invoked as a product operation. Ordinary compiler/source analysis is not runtime or acceptance.

Issue #2467 is not complete: real current host dependency storage/read and permissions, canonical source-preserving new draft revision CAS/transaction, revalidation of all host/target/permission/graph facts, idempotent commit/outbox/audit/invalidation, updated/conflict/failed receipts, independent compare-to-draft verifier and all original negative/positive runtime cases remain missing or unverified. No executable or independently accepted refresh command is delivered.

Keep this draft blocked on exact prerequisite ownership/composition and independent source review. Do not merge, mark Ready, close issues, publish packages, deploy, alter security settings or substitute static success for those gates. Rollback is omission/reversion of this bounded ordinary increment; no persisted or live data was changed.

## Exact implementation bytes

These identities bind ordinary source, not runtime evidence or any approval. The exact committed revision is supplied by the draft PR and final handoff rather than a self-referential document field.

| New source | Git blob | SHA-256 |
| --- | --- | --- |
| Shared `Authoring/ArticleEmbedRefreshPlanContracts.cs` | `4ea4f942e265c92bc4bd0903dc310a7c9d876fbc` | `59cba58ff7f1a536c130e62365d6d3ce6982e0cf284dd9704229a3db94196f24` |
| Shared `Authoring/ArticleEmbedRefreshPlanner.cs` | `2ed9d85e4e8f38da7bd5c296206e5cacbf688bd6` | `73a49d306310a27636f1651fdbcd71e02d5b65f9c41509157c0a48b955787e00` |
| Backend `Services/Authoring/ArticleEmbedRefreshPreparation.cs` | `6874247ecc5bc43ad9791af49dd60158e0be8162` | `2b68afd13d875453ba115643e515d9526f43cf94be43f308cef40a394eaef687` |
