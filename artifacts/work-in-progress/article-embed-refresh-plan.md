# Article embed refresh plan source WIP

This ordinary source handoff concerns open issue #2467 (original #2246 -> #2458). It is not an execution, authorization, persisted receipt or qualification artifact.

## Current recursive-entry compatibility repair

The active compatibility branch is `codex/issue-2467-recursive-entry-compatibility`, based on exact isolated Main #4350 `d385ea0b30cdeccb816fe11b381bb8827c9deda8`. That Main tree admitted all fourteen #4340 paths at `4d9c14434705e8e4c0c940352ee57e76ae4c550f` exactly. The fourteen-path/donor equality statements below describe that historical intake, not this compatibility candidate: seven of the eight prerequisite files are deliberately revised here and two explicit projection partial files are added within the same resolver/verifier owners. RefreshPolicy and the three refresh leaves remain unchanged, including the P2 cancellation fix and CanExecute=false.

Frozen consumers were read only: ResolverTests lines 174..185 require children/cycle; 203..208 requires a nested-to-top-level memo hit; 223..241 requires nested depth/node/byte/message failures. RelationDeriverTests directly composes Resolve -> DeriveFromAuthoring and expects the recursive edges. None of these tests, fixtures, assertions or project/lock files is modified, run or discovered.

The repair restores both complete original resolver/verifier source owners from actual pre-import Main #4348 `128f61f0c30768c061bbda32a1165371f417e517`. All four recursive resolver/verifier and relation-owner blobs there equal original Main `1016c633466fb18083a8ac0f6cc56e9bb448b99f`, the source used for restoration. Their original 28 top-level resolver/verifier method bodies match exactly, allowing only the explicitly required private-to-internal accessibility of shared mechanical helpers. Original Resolve executes its original recursion, whole-subtree memo reuse, path sensitivity, cumulative meter and clock calls. It does not forward to Pipeline.Graph. Original Verify retains recursive acceptance, child/cycle/depth traversal, original memo and budget checks; it does not acquire the projection-only no-children guard.

New ResolveProjection and VerifyProjection live in two partial files of those same existing owners, carrying the admitted projection algorithm under explicit names. Their ClassifyProjection/ExpectedProjectionFailure/ExpectProjection helpers retain the admitted current-fact, permission-concealment and source-revision policy; legacy Classify/ExpectedFailure/Expect stay private and keep their original semantics. GraphVerifier explicitly names the projection facts helpers. The eight shared binding/receipt/key/classification-mechanics helper bodies are identical between original Main and donor; graph fact-policy selection never resolves to a legacy helper accidentally.

Old DeriveFromAuthoring/VerifyFromAuthoring use only original recursive Verify; new DeriveFromGraph/VerifyFromGraph use only GraphVerifier. Each gate then consumes one shared private relation projection/independent-verification core. There is no verifier fallback, candidate-shape guessing or new authority. Pipeline explicitly calls ResolveProjection -> GraphPlanner (VerifyProjection) -> DeriveFromGraph. The recursive subtree memo contract and the graph stage's projection re-expansion/observation contract remain distinct. Static source restoration and compilation do not establish executed legacy/graph equivalence or running safety.

| Intake path, relative to the indicated owner | Current compatibility classification |
| --- | --- |
| `artifacts/change-contract/issue-2467-refresh-plan-external-naming.json` | unchanged historical #4340 metadata |
| `artifacts/work-in-progress/article-embed-refresh-plan.md` | revised compatibility WIP; historical results remain labelled |
| `docs/api/contracts.md` | revised explicit recursive/projection/graph entry documentation |
| Backend `Services/Authoring/ArticleEmbedRefreshPreparation.cs` | unchanged |
| Shared `ArticleEmbeds/Authoring/ArticleEmbedAuthoringPipeline.cs` | compatibility revised, explicit projection and graph admission calls |
| Shared `ArticleEmbeds/Authoring/ArticleEmbedAuthoringRefreshPolicy.cs` | unchanged |
| Shared `ArticleEmbeds/Authoring/ArticleEmbedAuthoringResolver.cs` | compatibility revised, original recursive source restored |
| Shared `ArticleEmbeds/Authoring/ArticleEmbedAuthoringVerifier.cs` | compatibility revised, original recursive verification restored |
| Shared `ArticleEmbeds/Authoring/ArticleEmbedRefreshPlanContracts.cs` | unchanged |
| Shared `ArticleEmbeds/Authoring/ArticleEmbedRefreshPlanner.cs` | unchanged, retains P2 cancellation repair |
| Shared `ArticleEmbeds/Graph/ArticleEmbedDependencyGraphPlanner.cs` | compatibility revised, explicit VerifyProjection gate |
| Shared `ArticleEmbeds/Graph/ArticleEmbedDependencyGraphVerifier.cs` | compatibility revised, explicit projection fact-policy helpers |
| Shared `ArticleEmbeds/Relations/ArticleEmbedRelationDeriver.cs` | compatibility revised, separate admission and shared private projection |
| Shared `ArticleEmbeds/Relations/ArticleEmbedRelationVerifier.cs` | compatibility revised, separate admission and shared private independent verification |
| Shared `ArticleEmbeds/Authoring/ArticleEmbedAuthoringResolver.Projection.cs` | new partial of the same existing resolver owner |
| Shared `ArticleEmbeds/Authoring/ArticleEmbedAuthoringVerifier.Projection.cs` | new partial of the same existing verifier owner |

A separate ordinary compatibility naming manifest covers this draft's exact nine managed-source paths and current API doc. All other Main source and all tests/frozen artifacts remain byte-preserved. No runtime, test/discovery, DB/native/browser, frozen evidence generation, qualification, merge/Ready/close or publication is performed.

## Current compatibility static verification

Actual selected-container SDK 10.0.401 and Node 24.19.0; original configuration, project graph, references, analyzers and warning policy remain intact. Raw ordinary diagnostics are under `/tmp/issue-2467-compat-static/`, not canonical/frozen qualification evidence.

- Isolated tracked-clean exact #4350 base and actual compatibility candidate both complete original `dotnet restore src/backend/FsusBlog.Server.csproj --locked-mode --nologo` and default complete `dotnet build src/backend/FsusBlog.Server.csproj --no-restore --nologo -v:minimal`, exits 0, 330 warnings/0 errors each. All 660 emitted diagnostic lines match with multiplicity after checkout-root/source-position-only normalization: added 0/removed 0.
- Original strict C# checker on all thirteen embed/refresh source paths, with original folder whitespace and solution style invocations, exits 0: 13 files/0 violations. No reduced project or checker, warning suppression, source rule, baseline or test change.
- Complete original C# full scan remains FAIL1/FAIL1, same 552 diagnostic lines. Original code-intent remains FAIL1/FAIL1, same two old findings; checked-source count 5740 -> 5742 reflects the two new partial files.
- Original lifecycle and authoritative-document checks remain FAIL1/FAIL1, same 7/41 diagnostic lines, byte-identical after checkout-root normalization. No inventory/index/catalog regeneration.
- Original required-tool API document lint remains FAIL1/FAIL1, same 26 findings after line-number-only normalization. Markdownlint is the same task-local 0.23.1 installation; no config/rule change. Existing global failures remain failures.
- Static original method-body comparison covers all 28 original resolver/verifier top-level methods; shared mechanical verifier helper comparison covers 8/8. These text comparisons are not product invocation, executed counterexamples or consumer acceptance. Frozen tests were only read; current test-tree diff is empty. RefreshPlanner P2 blob remains `4ad0fa76748aed1309a4fcf9b07d839d923dcd31`; Contracts, Preparation and RefreshPolicy are unchanged.

| Shared ArticleEmbeds source path | Exact #4350 base blob | Compatibility candidate blob |
| --- | --- | --- |
| `Authoring/ArticleEmbedAuthoringPipeline.cs` | `0f1393afa25817819a99af7ecbe2155b727513d5` | `6fbedf06ea590ed94ecfee430f0a63e99bf3c1f9` |
| `Authoring/ArticleEmbedAuthoringResolver.Projection.cs` | absent | `1f4177fa12571b88a5b20ea957d4c909ca87f50a` |
| `Authoring/ArticleEmbedAuthoringResolver.cs` | `bfab0407b5ee441b9521fec174fa41f5a3e5b789` | `6f4198632d65580984325915e5377738d10278f9` |
| `Authoring/ArticleEmbedAuthoringVerifier.Projection.cs` | absent | `018793223d4f90d3819b9ee185b510f5b09269cf` |
| `Authoring/ArticleEmbedAuthoringVerifier.cs` | `5ef77946e015b3527c40b6ba4a5191c55ea7029b` | `f47664c1134105d44170ffee7c658e8e4f5c3482` |
| `Graph/ArticleEmbedDependencyGraphPlanner.cs` | `9f0d7b928790b2c220db93aeaac540cb8673818f` | `c57384b7d96df44d295d550e2036c11def7c15a4` |
| `Graph/ArticleEmbedDependencyGraphVerifier.cs` | `2d77409763344422559de0e354a56a48a14761f1` | `e5f594c42c7d966638c27badb09d87feee9066f4` |
| `Relations/ArticleEmbedRelationDeriver.cs` | `34fa1617a717a5f9cb0d710fc7c3cb20b6f3ac97` | `90e731a7522cb03f1bd9b67189612d05301efd51` |
| `Relations/ArticleEmbedRelationVerifier.cs` | `a541b20cf529fbc3b58b76052affb9e5e54bd1db` | `d1e377925ccccb6c91b67fab10cb28e0b488b240` |

Original commit/whitespace/range and actual draft metadata checks bind the committed candidate and readback in the PR/final handoff. The static result does not close #2467 or any HOLD/independent acceptance requirement.

## Historical #4340 scope and ownership

- Direct base: Main draft #4335, `1016c633466fb18083a8ac0f6cc56e9bb448b99f`.
- Branch: `codex/issue-2467-nonexecuting-refresh-plan`.
- Exclusive implementation takeover from terminated task `01a13b6b-ccc3-77c0-a935-bff98eabb01d`; no replacement author was started.
- Initial three new implementation files: `ArticleEmbedRefreshPlanContracts.cs`, `ArticleEmbedRefreshPlanner.cs` in shared `Contracts/ArticleEmbeds/Authoring/`, and backend `Services/Authoring/ArticleEmbedRefreshPreparation.cs`. Contracts and Preparation retain their exact initial blobs. The later independent-review P2 repair changes only the planner's cancellation precedence; its current blob is recorded below.
- The explicitly authorized continuation admits eight exact canonical prerequisite files from #3958: four new leaves and four existing owners, listed below. The complete PR increment is eleven implementation paths plus one current API explanation, this ordinary WIP and required naming metadata (fourteen paths total).
- No other Main source, configuration, lockfile, fixtures, test source, schema, runtime registration or authority output changes. Donor history and historical runtime/test evidence are not imported.

## Implemented candidate

The request binds an explicit 1..256 occurrence selection, actor/site/permission context, exact host draft key/server expected revision/document epoch/source revision and digest, previously observed host facts digest and current authority generation/digest. Host facts require an ordered, non-overlapping complete roster of up to 4096 recorded dependency occurrences; the caller must establish its provenance and completeness. Structural hashing cannot establish either.

Each selection supplies the original sealed authoring provider request, parser-owned directive identity/range/token/mode and exact recorded/desired dependency coordinates. Duplicate directives/request IDs, mismatched old facts, wrong target mode/identity and host/actor/source/runtime drift refuse. No target fallback, Markdown parsing, implicit all/latest selection, target mutation, display content copy or publication path is introduced.

The planner is written against the existing `ArticleEmbedAuthoringPipeline.Evaluate` (Resolver -> DependencyGraphPlanner -> RelationDeriver), `ArticleEmbedDependencyGraphVerifier` and `ArticleEmbedAuthoringRefreshPolicy.TryCompare`. The latter remains the sole compare owner; its boolean is expanded into immutable bound plan data, not treated as execution permission. Target/permission/kind/anchor/cycle/budget failures refuse the whole explicit set, without a partial plan. Host/authority/desired coordinate and reachable target observation drift return Stale; an unchanged set returns NoChange; cancellation returns no plan. Pipeline graph evaluation covers only selected current targets. It does not certify unselected persisted host graph safety.

The candidate plan has no public constructor/setters and retains only immutable arrays of sealed immutable coordinate/directive records and metadata. It freezes request/host/actor/source, exact old/new coordinates, target source digests, observed permission/lifecycle, runtime/material context, selected graph topology, relation/graph digests and closed budgets/observations under the shared canonical digest writer. It has no target source, attribution display text, publication artifact, database row or cancellation token. `CanExecute` is always false.

Backend preparation is a static, unregistered facade requiring observations as arguments. It supplies no reader, permission authority, DB transaction, endpoint or DI registration; missing real host facts block. Its execution-capability list explicitly retains missing canonical host dependency read, current host/target permission and whole-host graph revalidation, expected-revision CAS/idempotency, and canonical no-source-change draft revision/outbox/audit commit. A caller supplying a structural record does not satisfy those capabilities.

## Historical #4340 prerequisite source admission

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

Static diff of that exact eight-file set against the base was 1104 insertions, 421 deletions. The initial six-path checkpoint `1d053d4312f4fa32814417cff4d5054c8c5f2e14` imported none and failed compilation. The parent subsequently explicitly authorized exactly these eight ordinary source files, retaining non-execution and all HOLD boundaries. At #4340 checkpoint they were admitted byte-for-byte; no donor history or historical test/runtime evidence was imported. Reference #3953 `8c239073c3a7f602b43f27264aa22bee33a6d334` is source context only. Those eight checkpoint files also matched #4162 `cdf46ba5934f3d068c0018dc8ef3551223dcfb7d` exactly. Current compatibility revisions are classified above; equality with the donor is not claimed for them.

The merge base of exact Main and donor is `3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`. All four existing Main files equal their common-ancestor blobs, with no intervening path history; all four new leaves are absent in both. Thus this exact eight-file application overwrites no Main-specific path repair. Every other Main path is byte-preserved by the explicit file roster; that is not a claim of unchanged behavior at old callers of these modified owners. Ordinary preimage/postimage diagnostic maps are retained under `/tmp/issue-2467-static/`; they are not execution receipts or frozen authority.

| Shared ArticleEmbeds path | Original Main/common-ancestor blob | Historical exact donor/#4340 intake blob |
| --- | --- | --- |
| `Authoring/ArticleEmbedAuthoringPipeline.cs` | absent | `0f1393afa25817819a99af7ecbe2155b727513d5` |
| `Authoring/ArticleEmbedAuthoringRefreshPolicy.cs` | absent | `b619186b6c347e53297ceb868caa6939eba8e15b` |
| `Authoring/ArticleEmbedAuthoringResolver.cs` | `e41eb8e74cbc4a705c781c8c9eda4a126c93f719` | `bfab0407b5ee441b9521fec174fa41f5a3e5b789` |
| `Authoring/ArticleEmbedAuthoringVerifier.cs` | `aec457522363d8769953e2c567aab343c7fef331` | `5ef77946e015b3527c40b6ba4a5191c55ea7029b` |
| `Graph/ArticleEmbedDependencyGraphPlanner.cs` | absent | `9f0d7b928790b2c220db93aeaac540cb8673818f` |
| `Graph/ArticleEmbedDependencyGraphVerifier.cs` | absent | `2d77409763344422559de0e354a56a48a14761f1` |
| `Relations/ArticleEmbedRelationDeriver.cs` | `7a420b9d4ca1c93f387f0e77d23a8f0aeb448288` | `34fa1617a717a5f9cb0d710fc7c3cb20b6f3ac97` |
| `Relations/ArticleEmbedRelationVerifier.cs` | `7ed05b25f1e73d82f53f5432169a49ac8dd60e40` | `a541b20cf529fbc3b58b76052affb9e5e54bd1db` |

## Historical conflict in the donor split

This admission is not semantics-preserving for every old recursive entry call. On the Main base, direct `ArticleEmbedAuthoringResolver.Resolve` produced recursive children and its `ArticleEmbedAuthoringVerifier.Verify` verified that recursive shape. The exact donor changes those same method names to projection-only resolution and projection verification. Nested expansion, nested cycle/depth/node/byte observations and graph verification now belong to `ArticleEmbedDependencyGraphPlanner.Expand` and `ArticleEmbedDependencyGraphVerifier`; `ArticleEmbedAuthoringPipeline.Evaluate` composes these stages. Relation derivation/verification now requires the graph verifier, which can reject an unexpanded projection where nested facts require children.

At that checkpoint the new refresh planner consumed the explicit pipeline, while old direct callers were not migrated and lost their required recursive behavior. The active compatibility repair restores those old owners and introduces explicitly named projection/graph gates instead of requiring a frozen-consumer migration. No runtime equivalence of nested output, budgets, cancellation, memoization or relation-admission behavior has been established. Compilation, source-body restoration and donor-byte equality do not establish executed semantics; all relevant runtime/consumer/negative-case validation remains HOLD/UNRUN.

## Independent-review P2 cancellation repair

At source checkpoint `f1259278279324490ccb6c1a923c342a8cdacb74`, cancellation after projection completion could make the graph stage reject that projection: the verifier now expects `request_aborted` while the earlier projection still says Resolved. The refresh planner returned Blocked before reaching its later cancellation guard. This was a real status-classification defect found by independent static review; no executed cancellation case is claimed.

The repair checks the entire validated explicit request set immediately after `Pipeline.Evaluate` returns. Its post-selection failure helper also rechecks cancellation at the actual Blocked/Stale return boundary, including cancellation during independent graph verification and `TryCompare`. Authority validation, desired-coordinate and reachable-target drift failures share that precedence after selection validation. A final cancellation observation after immutable plan construction covers cancellation during later graph projection/digest work; observed cancellation returns Cancelled with no plan. The original request/selection validation and all permission/coordinate/graph/budget rejection rules remain; no denied result can become an executable plan.

These are finite observation points, not an atomic cancellation or commit guarantee. Cancellation after the final observation is not retrospectively observed. No runtime race/transition case, test, discovery, product method or compiled assembly is executed to claim behavioral qualification. The eight donor source blobs stayed exact through the P2 checkpoint; current compatibility revisions are classified above and keep the P2 planner bytes unchanged.

P2 static checks, raw ordinary logs under `/tmp/issue-2467-static/p2/`:

- Actual original complete Server locked restore and default build both exit 0, 330 warnings/0 errors. All 660 emitted diagnostic lines match the isolated exact Main base with multiplicity, added 0/removed 0 after checkout-root/source-position-only normalization. No compiler/reference/analyzer/configuration suppression or reduced project.
- Original strict C# checking of all eleven source files exits 0, 11 files/0 violations; original whitespace and solution style invocations retained.
- Original complete full-style, code-intent, lifecycle and authoritative-doc checks remain FAIL1, with respectively 552/3/7/41 lines byte-identical to `f1259278279324490ccb6c1a923c342a8cdacb74` diagnostics. The two actual code-intent errors and all other original global failures remain, not waived.
- Original required-tool API docs lint remains FAIL1, the same 26 findings after line-number-only normalization against exact Main. Git whitespace checking passes; the ordinary naming manifest remains unchanged because the governed path roster is unchanged.
- Exact donor source parity remains 8/8. Only the refresh planner, current API explanation and this ordinary WIP differ from the P2 review head. Final commit-range/actual PR metadata are bound by the readback and final handoff; these static results provide no running cancellation, recursion-equivalence or qualification evidence.

## Static verification

Raw diagnostic logs are retained at `/tmp/issue-2467-static/` in this selected container. Those logs are local diagnostics, not canonical receipts or portable acceptance.

- Historical initial three-file complete original Server build: `dotnet build src/backend/FsusBlog.Server.csproj --no-restore --nologo -v:minimal` actually exited 1, CS0234: missing `FsusBlog.Shared.Contracts.ArticleEmbeds.Graph`. This real failure remains recorded and is not relabelled as passing.
- Original strict C# checker including its original folder whitespace and solution style commands: `node tools/dotnet/check-csharp-style.mjs --mode strict-full --file src/shared/Contracts/ArticleEmbeds/Authoring/ArticleEmbedRefreshPlanContracts.cs --file src/shared/Contracts/ArticleEmbeds/Authoring/ArticleEmbedRefreshPlanner.cs --file src/backend/Services/Authoring/ArticleEmbedRefreshPreparation.cs` exits 0, 3 files/0 violations. The first run failed whitespace and one Allman-brace finding; those new-file formatting defects were repaired and the failure log is retained.
- SDK is the existing 10.0.401 installation, Node is 24.19.0. Only SDK PATH, task-local CLI home and existing NuGet cache are selected; no build property, warning policy, project/reference graph, lockfile or checker is changed.
- An isolated, tracked-clean checkout `/workspace/issue-2467-base-static` at exact `1016c633466fb18083a8ac0f6cc56e9bb448b99f` completed original `dotnet restore src/backend/FsusBlog.Server.csproj --locked-mode --nologo` and the same full Server build, both exit 0, with 330 warnings/0 errors. No candidate files are present in that checkout. An earlier pre-planner build in the working checkout also succeeded, but the isolated exact-base run is the comparison evidence.
- Complete original `node tools/dotnet/check-csharp-style.mjs --mode full` remains FAIL1 on base and candidate: 552 diagnostic lines, identical after exact checkout-root normalization; no new-path findings. This does not waive whole-project style debt.
- Complete original `node tools/governance/check-code-intent.mjs` remains FAIL1 on both: the same two existing frontend performance-wording errors. Only its checked-file count changes 5714 -> 5717 for the three new C# files.
- Original `node tools/docs/generate-document-lifecycle.mjs --check` remains FAIL1/FAIL1 with the same 7 lines; `node tools/docs/check-authoritative-development-docs.mjs` remains FAIL1/FAIL1 with the same 41 lines. Full logs are identical after checkout-root normalization. No document lifecycle/index/catalog was regenerated.
- Required-tool native document lint initially exits 1 because `markdownlint-cli2` is missing. That failure is retained. Installing only `markdownlint-cli2@0.23.1` under `/tmp/issue-2467-tools` with lifecycle scripts disabled, then rerunning original `./tools/lint.sh docs --require-tools --file docs/api/contracts.md` gives FAIL1/FAIL1, 26 existing findings on base/candidate. Complete diagnostic text is identical after line-number-only normalization; added paragraph shifts later locations by 16 lines. The native checker excludes ordinary artifacts under its existing policy; its checked document count is 1, not the WIP or naming manifest. No rule or exclusion was changed.
- Initial naming metadata, whitespace, commit-range/repository and actual draft #4340 REST metadata checks passed at initial six-path checkpoint. Continuation checks are reported against the final fourteen-path candidate separately, not inferred from that checkpoint.

## Historical #4340 authorized continuation verification

- Actual composed candidate `dotnet restore src/backend/FsusBlog.Server.csproj --locked-mode --nologo` exits 0. Actual original complete `dotnet build src/backend/FsusBlog.Server.csproj --no-restore --nologo -v:minimal` exits 0, 330 warnings/0 errors, with every default project/reference/analyzer/configuration intact. No reduced project or compiler-policy suppression. Initial CS0234 is resolved by admitting the exact original owners, not by weakening compilation.
- Complete compiler diagnostic text and multiplicity match the isolated exact base: 660 diagnostic lines in each log (the build repeats its 330 warnings in the summary), added 0/removed 0 after normalizing only the two checkout roots and source line/column positions. This is not a zero-warning result.
- Strict original C# checking for all eleven source paths exits 0 (11 files/0 violations), with original whitespace and solution style commands unchanged. No donor source formatting, member, diagnostic or ownership edits were required.
- Complete C# full scan remains FAIL1/FAIL1, 552 identical lines after checkout-root normalization. Complete code-intent remains FAIL1/FAIL1, same two existing failures; scan count 5714 -> 5721 reflects seven total added source files (three original refresh leaves plus four prerequisite leaves).
- Original lifecycle and authoritative-document checks remain FAIL1/FAIL1, with the same 7 and 41 diagnostic lines respectively; no generated inventory/index edits. These original global failures remain failures.
- Current API explanation now distinguishes projection verification from explicit graph verification and documents the admitted source composition without claiming a live grant or executing refresh path. Prior initial compile failure and all non-execution gaps remain recorded above/below.
- Original required-tool API docs lint remains FAIL1/FAIL1 with the same 26 findings; full diagnostics match after line-number-only normalization. The original missing-tool failure and task-local Markdownlint installation are retained above. Naming metadata is expanded to the exact eleven managed-source paths, with no naming registry/rule change.

## Execution and acceptance remain HOLD

All runtime, tests, collection/discovery/list, product/import execution, database, native/browser, frozen receipt/schema/catalog fixture generation and qualification are HOLD/UNRUN. No refresh/planner/pipeline method, compiled assembly, product endpoint, source generator authority producer, DB/catalog/preflight or import helper has been invoked as a product operation. Ordinary compiler/source analysis is not runtime or acceptance.

Issue #2467 is not complete: real current host dependency storage/read and permissions, canonical source-preserving new draft revision CAS/transaction, revalidation of all host/target/permission/graph facts, idempotent commit/outbox/audit/invalidation, updated/conflict/failed receipts, independent compare-to-draft verifier and all original negative/positive runtime cases remain missing or unverified. No executable or independently accepted refresh command is delivered.

Keep this draft pending independent source review and all missing real execution/qualification owners. Source prerequisite admission does not supply those capabilities. Do not merge, mark Ready, close issues, publish packages, deploy, alter security settings or substitute static success for those gates. Rollback is omission/reversion of this bounded ordinary increment; no persisted or live data was changed.

## Exact implementation bytes

These identities bind ordinary source, not runtime evidence or any approval. The exact committed revision is supplied by the draft PR and final handoff rather than a self-referential document field.

| New source | Git blob | SHA-256 |
| --- | --- | --- |
| Shared `Authoring/ArticleEmbedRefreshPlanContracts.cs` | `4ea4f942e265c92bc4bd0903dc310a7c9d876fbc` | `59cba58ff7f1a536c130e62365d6d3ce6982e0cf284dd9704229a3db94196f24` |
| Shared `Authoring/ArticleEmbedRefreshPlanner.cs` after P2 cancellation repair | `4ad0fa76748aed1309a4fcf9b07d839d923dcd31` | `332c98d378d4d36f0e582f38131899df460e051858774e186c79a58a5e1fad5e` |
| Backend `Services/Authoring/ArticleEmbedRefreshPreparation.cs` | `6874247ecc5bc43ad9791af49dd60158e0be8162` | `2b68afd13d875453ba115643e515d9526f43cf94be43f308cef40a394eaef687` |
