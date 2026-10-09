## Linked Issue

Refs #2406

Related unfinished scope: [#2418](https://github.com/Ozwasyd/FsusBlog/issues/2418). Original package planner and integration ownership remain with [#3663](https://github.com/Ozwasyd/FsusBlog/issues/3663).

## Scope Summary

- Initial WIP read-only module from integrated base `08787f22f038569e893d6d1a4923aebc5b6bbe0f`, delivered at `7d23fc30865a206de0b31df527a6b6e59cd7c932` on `article-package-candidate-review-delivery-20261009-0753`.
- Six expressly released new module paths:
  - `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateReviewContracts.cs`
  - `src/backend/Services/Authoring/ArticlePackageImportCandidateReviewProjection.cs`
  - `tests/backend/Unit/ArticlePackageImportCandidateReviewProjectionTests.cs`
  - `src/frontend/src/api/types/articlePackageCandidateReview.ts`
  - `src/frontend/src/components/admin/article-packages/ArticlePackageCandidateReview.vue`
  - `tests/frontend/unit/components/admin/ArticlePackageCandidateReview.test.ts`
- The backend-tested verification source is `1ec04f0fef46b4c66337c2c95295e4b6c090d99c` on `article-package-review-backend-verification-20261009-0810`, with its original-owner compiler prerequisites. Latest frontend source is `0ea8b5246968602a570909c21104724b57e64a6d` on `article-package-review-page-identity-delivery-20261009-a91f`, based directly on `134649893ec14884be584af82e7d583a218f8f2f`. The follow-up changes only the frontend type, Vue and ordinary component-test paths; shared DTO, backend projection and backend tests are unchanged. Ordinary test/provenance artifacts are under `artifacts/article-packages/candidate-review-backend-verification-20261009/`.
- Project the actual immutable candidate plan with original component/plan digests, existing finite candidate summary, requested mode, caller-asserted UTC interval, at most 50 requested target hints per page, and original required authorities. Exact decimal-string Int64 revisions and UTC strings retain original precision. No Actor/session details, private titles, source bytes, target resolution, authority, execution result or successful validation receipt are produced.
- Pagination now emits a frozen UI-only `requestId`/digest/pageIndex/pageSize identity. The host supplies a typed `pageCompletion`: exact ready projection, or identified cancelled/error. Only the active request settles. Accepted page data remains visible until matching completion; cancellation retains it. Ignore late/duplicate/uncorrelated outcomes and page-response writes mirrored into context props. Clear pageCompletion for authoritative context updates, and clear review before resetting the same candidate after error. No backend DTO or transport request identity is invented.
- Execute remains disabled with `article_package_import_authority_unavailable`. Page requests emit only a digest-bound read request to the host; there is no transport, route mounting or business write. The component handles empty/loading/error/stale states, bounds supplied read fields, and preserves pagination focus.
- The original planner blob `703501fe781def4f7818bff75fb7943b24ae2406` remains unchanged. The shared contract path was confirmed absent and explicitly released by the original owner's `b734d38e3cf11101079d61bc78764c99ee13322d` release file; no rebase onto later package work was performed.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [x] Public contract change
- [ ] External naming exception
- Contract impact: breaking

The additive shared read-model contract has no authenticated transport or public wire/ABI mapping yet. The draft frontend host must echo the complete request in pageCompletion; old bare review/state page updates cannot settle a read. This required caller adaptation is explicitly marked in the source commit; no existing mounted host or released backend wire contract was changed.

## Tests Run

- [ ] `./tools/test.sh fast` — UNRUN; no default/full suite selected.
- [x] Targeted backend tests: PASS 18/18 on the actual verification source `1ec04f0fef46b4c66337c2c95295e4b6c090d99c`; no skipped or failed cases. Original `dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --list-tests --filter 'FullyQualifiedName~ArticlePackageImportCandidateReviewProjectionTests&Category=Unit&Fixture!=LocalRedis'` first rebuilt the complete real project with 0 compiler errors and 1512 observed warning lines. Preflight required exactly 18 unique expected names/arguments: 8 facts, 7 invalid-page cases and 3 caller-interval cases. Original project/startup hooks and resources were inspected; the selected class has no external-resource fixture and the original Redis diagnostic initializer was inactive. Only after successful positive discovery, run `dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --no-build --filter 'FullyQualifiedName~ArticlePackageImportCandidateReviewProjectionTests&Category=Unit&Fixture!=LocalRedis' --logger 'trx;LogFileName=article-package-review-projection.trx' --results-directory /tmp/article-package-review-projection-results --logger 'console;verbosity=normal'`. Exit 0, total/executed/passed 18, failed/notExecuted 0. The ordinary TRX names/arguments exactly match the discovered set. No unrelated Export/compiler-prerequisite tests or held controls ran. No original test entrypoint/configuration or alternate acceptance harness was used.

  Compiler prerequisites were consumed through their owners, preserving assertions: matched lock repair `bd3dbde7939dc95c81cef4ab6b50f883459ee85d` (49/49 package-input preimages, own SDK 10.0.401 audit-on locked restore PASS); four bootstrap literals from `f53b6b79f8cf051bd190cad2e49a57ea4a1cc1bd`; original poll-field repair `e724251e44222c1c36388984f71f88e901a02c48`; only necessary existing master import/declaration/call-contract hunks from `57886f75213bd22c0dd3a8e2586073bdbdd97778`; and the original-owner two-line no-embed-plan fixture constructor repair `1ec04f0fef46b4c66337c2c95295e4b6c090d99c`, whose direct parent exactly matched `6baf73bbe6f3a05b198dad4d25c882fec7ece79d`. That last source was fast-forwarded unchanged, and every other source byte/assertion matched its parent. Supplier restore/build results were not transferred as this candidate's test acceptance. Earlier failed preflights remain historical diagnostics, not current blockers.
- [x] Targeted frontend checks: PASS 34/34 on `0ea8b5246968602a570909c21104724b57e64a6d`, with 23/23 original HTML-sink hooks and original public-page-manifest check. First reproduce both original inputs on the preceding Vue/type sources using the ordinary entrypoint: original 20 PASS, two new regressions FAIL (22 selected, exact nonempty count; happy-dom, not a browser runtime). The final selector then asserted exactly one nonempty file and 34 unique cases, preserved all original 20 controls/assertions and both original-input regressions, and verified the exact 23 hook fixture identities before `npm run test:unit:fast -- ../../tests/frontend/unit/components/admin/ArticlePackageCandidateReview.test.ts`. Actual result identities exactly match the positive selection. The 14 additions cover size mismatch, explicit cancellation, uncorrelated ready, late success/error/cancel after same-coordinate retry, all request fields, duplicate success, context replacement, mirrored stale results and error/empty recovery. No test include/configuration or ordinary setup changes.
- [x] Targeted follow-up source checks: original strict-full frontend style PASS on the Vue/type source pair (2 ESLint / 1 Stylelint / 0 violations); ordinary test hierarchy check and diff whitespace PASS. The repository style policy selects only .mjs under tests, so unit-test TypeScript style remains UNRUN: no test-file style PASS is claimed.
- [ ] Complete app typecheck: FAIL (exit 1), `npx --no-install vue-tsc --noEmit -p tsconfig.app.json`, 311 diagnostics. This SFC contributes only the existing `@ozwasyd/element-plus` declaration gap at its unchanged import; no new request/completion type diagnostics appeared in the actual app check. This is a failing app gate, not a waiver. The eight shared compiler prerequisite files were not edited by this UI fix. The independent review also reports 103 whitespace and 3 import-order findings in that prerequisite scope; they remain owner work, not claimed fixed or revalidated here.
- [x] Other on module source `7d23fc30865a206de0b31df527a6b6e59cd7c932`: `dotnet build src/backend/FsusBlog.Server.csproj --no-restore` PASS (0 errors, 322 warnings outside the new projection/DTO); `npm run typecheck:local-fsusui` PASS for its original consumer-export include set, which does not include this component and is not full-app or module type acceptance; repository strict frontend style check on the two new source files, ordinary frontend layout check, targeted shared/backend C# whitespace verification, final title/message validation, and `git diff --check 08787f22f038569e893d6d1a4923aebc5b6bbe0f..HEAD` PASS.

Original component controls and the new completion controls cover accurate labels and unknown counts, create/update assertions, no execute emission, 0/1/1000 review states, malformed/overbudget read fields, Int64 strings, stale/refusal states, digest-bound pagination, native button semantics, live regions and focus through loading/error/replacement. These are ordinary component tests, not rendered browser or independent UX acceptance.

## UI Evidence

- [ ] Screenshots or video attached for UI changes — UNRUN.
- [ ] Mobile layout checked — UNRUN in a rendered browser.
- [ ] Dark mode checked — UNRUN in a rendered browser.
- [x] Accessibility and reduced-motion impact considered — semantic headings/lists, labels, disabled explanation, live state and focus controls are tested; responsive CSS consumes public tokens and contains no animation. Actual assistive-technology, zoom, touch and browser rendering remain UNRUN.

## Coding Convention

- [x] C# mother-style mapping checked
- [x] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [x] `.git-blame-ignore-revs` updated when applicable
- Formatter identity: repository frontend style toolchain; .NET whitespace formatter
- Formatter version: locked ESLint 10.8.0 / Stylelint 17.14.1; .NET SDK 10.0.401
- Formatter command: `node tools/frontend/check-frontend-style.mjs --mode strict-full --file src/frontend/src/api/types/articlePackageCandidateReview.ts --file src/frontend/src/components/admin/article-packages/ArticlePackageCandidateReview.vue --file tests/frontend/unit/components/admin/ArticlePackageCandidateReview.test.ts`; targeted `dotnet format whitespace ... --no-restore --verify-no-changes --include ...`
- Formatter idempotence evidence: none
- Blame-ignore revision: none

## External Naming Exception

- Exceptions manifest: none

## Documentation / Intent

- [x] Public API docs updated
- [x] Ownership/security/performance intent updated
- [x] Historical handoff archived or source-of-truth updated
- [x] TODO/FIXME references valid issues

## Compatibility And Risk

- [x] Cross-language coding conventions reviewed
- [x] Document lifecycle updated: stable facts are current; issue handoffs are historical/proposed; generated docs identify their producer
- [x] External wire / ABI / database / third-party names preserved or explicitly adapted
- [x] Public API impact reviewed
- [x] AEDS frame / binary contract impact reviewed
- [x] Database migration impact reviewed
- [x] Security, auth, moderation, PoW, or privacy impact reviewed
- [x] Docs updated or a reason is recorded below
- [x] Known limitations updated if applicable

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: performance qualification, native/runtime custody, full export/import lifecycle, release/production acceptance.

## Release Note

- Audience: user-facing
- Category: Added
- Summary: add read-only package candidate review

Matching initial proposed label: `release-note:added`; the latest commit is a draft frontend-host contract correction marked `fix(frontend)!`; no PR or label has been created by this task. The source module is currently unmounted and is not an active product route.

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: original owner consumes the real six-path source candidate, consumes the complete source and matched canonical compiler prerequisites, adapts the unmounted read host to the typed completion contract, resolves the full-app/style prerequisite gaps, and performs the remaining owner integration and rendered UX acceptance. Owner separately supplies authenticated route and permission projection. No production rollout performed.
- Rollback: exclude or revert this unmounted six-path module before integration; no business data, database, planner or route state has changed.
- Deferred work: full export, intake, compatible target/unknown resolution, executor, receipts/results/recovery center, authenticated read transport, permission projection and rendered independent UX acceptance.
- Known limitations: 0-article plans are rejected by the original codec; the component's empty state means no supplied candidate. Assets/unresolved counts are explicitly unknown. Caller interval status does not establish current store, actor permission, policy or target validity. Initial lock/compiler failures were resolved through exact owner prerequisites. Original backend discovery and execution PASS at 18/18 on the unchanged backend-tested source; these tests were not rerun for this frontend-only fix. Latest frontend discovery and execution PASS at 34/34, with 23/23 hooks. Whole-project warnings and historical source style diagnoses are not claimed fixed; no whole-project strict-style acceptance is claimed. This does not complete #2406 or #2418.

## Notes For Reviewers

The initial module delivery branch changes only the six expressly released new paths. The latest correction changes three of those six paths only: frontend API type, Vue component and dedicated ordinary component tests. Its planner, registry, DI, HTTP/API entrypoints, historical metadata mapping, existing tests/configuration and integration branch are untouched. The separate verification branch additionally consumes only the explicitly authorized original-owner compiler prerequisites and records the ordinary diagnostics described above. The published initial delivery branch is based on the specified integrated base; the latest source branch starts from the complete prior published verification head and introduces no wide source import; its two commits have supported scopes and Refs footers. An earlier separate WIP source branch was published before completion. Consume the latest frontend fix branch/SHA named above together with the documented unchanged backend/source prerequisites. No published history was rewritten, no integration ref was pushed/reset, and no GitHub content writes, PR merge, deployment, migration or package publication occurred.

The actual issue bodies and planner source were inspected. DTO documentation and this WIP body record the source/permission/transport boundaries and integration gaps. Public API documentation update is not applicable beyond the documented additive DTO: no public route, AEDS schema, ABI or database contract is added. No current design authority or documentation lifecycle file is changed within the exclusive-path release. Historical handoff archiving and generated-document updates are not applicable; no such artifacts are introduced. TODO/FIXME review is not applicable: none is added. Broad format-only work and blame-ignore revision updates are not applicable: every module/test path is new and there is no existing-file mechanical reformat. These reasons support the not-applicable review checkboxes above without claiming additional implementation.

Active local FsusUI source resolves through the repository resolver to `/workspace/FsusUI`, HEAD `b17077f3afd4a80ff3bdc0fe81d5dfc353ffddf2`, with clean tracked state. Applied both repository design skills, task/status surface rules, public Button and spacing contracts. Product composition stays in FsusBlog with public FsusUI controls/tokens and no private selectors or component geometry overrides. No independent UX receipt or rendered conformance is claimed. Existing original-owner test controls or preceding package heads provide no acceptance for this candidate. No issue is closed by this source delivery.

Follow-up evidence: /tmp/article-package-review-nu1004-delta.json, /tmp/article-package-review-canonical-lock-input-match.json, /tmp/article-package-review-canonical-locked-restore.log, /tmp/article-package-review-canonical-backend-discovery.log and /tmp/article-package-review-backend-followup.json. Existing frontend results were not rerun. The original module branch and original project/lock source remain clean and unchanged.

Latest tested source: `1ec04f0fef46b4c66337c2c95295e4b6c090d99c` on `article-package-review-backend-verification-20261009-0810`. Beyond the unchanged module, the full compiler-prerequisite scope is one existing lock file (`tests/backend/packages.lock.json`) and eight existing test files: `LifecycleHostedBootstrapServiceTests.cs`, `AuthoringExtensionRpcBrokerTests.cs`, `TaxonomyExactMetadataTests.cs`, `SecurityAdminPolicyDefaultsTests.cs`, `RealConcurrencyHarnessTests.cs`, `DocumentExportContractTests.cs`, `CanonicalArticleLifecycleScheduledFailureTests.cs` and `CanonicalArticleProjectionVerifierTests.cs`, all under `tests/backend/Unit/`. Only the already published minimal compiler hunks were consumed; original assertions were preserved. No broader package-owner source or unrelated master tests were imported.

Current artifacts include `positive-discovery.json` with the exact 18 names/arguments, `resource-preflight.json`, `owner-constructor-consumption.json` with exact preimages, `execution-summary.json`, original output archived as `test-run.txt`, ordinary TRX XML archived as `projection-results.xml`, and the full repository-template WIP body. Earlier failed discovery and compiler/lock provenance are retained as historical information. All are under `artifacts/article-packages/candidate-review-backend-verification-20261009/`. No missing implementation input remains for the assigned P2 source fixes. Latest frontend results are bound to 0ea8b5246968602a570909c21104724b57e64a6d; original backend results remain bound to its unchanged backend source. Full-app typecheck and owner prerequisite style findings remain unresolved gates; unit-test TS style is UNRUN, and no broad prerequisite edits were made. Authenticated route/permission integration, full export/intake/resolution/executor/results flow and rendered independent UX acceptance remain explicitly deferred.

The original logger outputs remain at `/tmp/article-package-review-projection-results/article-package-review-projection.trx` and `/tmp/article-package-review-owner-constructor-tests.log`. Their published `.xml`/`.txt` copies preserve every byte and respect the repository’s ignored `.trx`/`.log` extensions; no logger, test include or configuration changes were made.

Frontend follow-up artifacts: `frontend-page-identity-followup.json` records the complete six-path changed/unchanged scope, typed host contract, original failure reproduction, exact positive 34-case selection and actual coverage/gaps. `frontend-page-identity-reproduction.json` preserves the original 20 PASS / 2 FAIL ordinary result; `frontend-component-results.json` preserves the actual final 34 PASS result. Browser plugin is unavailable; existing Playwright CLI 1.59.1 is installed, but the component has no mounted route or original e2e flow. No synthetic HTTP, new route/config, substitute rendered host, receipt/tamper/held audit or independent browser acceptance was created. These P2s are reproduced in ordinary happy-dom component controls, not claimed observed in a browser. The same existing reviewer should consume the actual new source; no new review, PR content write or issue closure was performed.

The early source-only WIP `d325aa99bd8ecf3847eb7246b999716a749c0aef` had separate footer paragraphs rejected by the repository parser. No published history was rewritten. The delivery branch starts anew from the same `134649893ec14884be584af82e7d583a218f8f2f` base, carries identical Vue/type/test bytes in validated commit `0ea8b5246968602a570909c21104724b57e64a6d`, and has its own fresh positive 34-case selector, 34/34 ordinary execution, 23/23 hooks, strict source-style PASS and full-app FAIL at 311 diagnostics. Consume this delivery source; the older branch provides no required commit-gate pass.
