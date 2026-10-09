## Linked Issue

Refs #2406

Related unfinished scope: [#2418](https://github.com/Ozwasyd/FsusBlog/issues/2418). Original package planner and integration ownership remain with [#3663](https://github.com/Ozwasyd/FsusBlog/issues/3663).

## Scope Summary

- WIP read-only module from integrated base `08787f22f038569e893d6d1a4923aebc5b6bbe0f`, delivered at `7d23fc30865a206de0b31df527a6b6e59cd7c932` on `article-package-candidate-review-delivery-20261009-0753`.
- Six expressly released new module paths:
  - `src/shared/Contracts/ArticlePackages/ArticlePackageImportCandidateReviewContracts.cs`
  - `src/backend/Services/Authoring/ArticlePackageImportCandidateReviewProjection.cs`
  - `tests/backend/Unit/ArticlePackageImportCandidateReviewProjectionTests.cs`
  - `src/frontend/src/api/types/articlePackageCandidateReview.ts`
  - `src/frontend/src/components/admin/article-packages/ArticlePackageCandidateReview.vue`
  - `tests/frontend/unit/components/admin/ArticlePackageCandidateReview.test.ts`
- The complete verification source is `1ec04f0fef46b4c66337c2c95295e4b6c090d99c` on `article-package-review-backend-verification-20261009-0810`. It contains the unchanged six-path module and only the explicitly authorized original-owner compiler prerequisites. Ordinary test/provenance artifacts are under `artifacts/article-packages/candidate-review-backend-verification-20261009/`.
- Project the actual immutable candidate plan with original component/plan digests, existing finite candidate summary, requested mode, caller-asserted UTC interval, at most 50 requested target hints per page, and original required authorities. Exact decimal-string Int64 revisions and UTC strings retain original precision. No Actor/session details, private titles, source bytes, target resolution, authority, execution result or successful validation receipt are produced.
- Execute remains disabled with `article_package_import_authority_unavailable`. Page requests emit only a digest-bound read request to the host; there is no transport, route mounting or business write. The component handles empty/loading/error/stale states, bounds supplied read fields, and preserves pagination focus.
- The original planner blob `703501fe781def4f7818bff75fb7943b24ae2406` remains unchanged. The shared contract path was confirmed absent and explicitly released by the original owner's `b734d38e3cf11101079d61bc78764c99ee13322d` release file; no rebase onto later package work was performed.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [ ] Generated output
- [x] Public contract change
- [ ] External naming exception
- Contract impact: compatible

The additive shared read-model contract has no authenticated transport or public wire/ABI mapping yet.

## Tests Run

- [ ] `./tools/test.sh fast` — UNRUN; no default/full suite selected.
- [x] Targeted backend tests: PASS 18/18 on the actual verification source `1ec04f0fef46b4c66337c2c95295e4b6c090d99c`; no skipped or failed cases. Original `dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --list-tests --filter 'FullyQualifiedName~ArticlePackageImportCandidateReviewProjectionTests&Category=Unit&Fixture!=LocalRedis'` first rebuilt the complete real project with 0 compiler errors and 1512 observed warning lines. Preflight required exactly 18 unique expected names/arguments: 8 facts, 7 invalid-page cases and 3 caller-interval cases. Original project/startup hooks and resources were inspected; the selected class has no external-resource fixture and the original Redis diagnostic initializer was inactive. Only after successful positive discovery, run `dotnet test tests/backend/FsusBlog.Server.Tests.csproj --no-restore --no-build --filter 'FullyQualifiedName~ArticlePackageImportCandidateReviewProjectionTests&Category=Unit&Fixture!=LocalRedis' --logger 'trx;LogFileName=article-package-review-projection.trx' --results-directory /tmp/article-package-review-projection-results --logger 'console;verbosity=normal'`. Exit 0, total/executed/passed 18, failed/notExecuted 0. The ordinary TRX names/arguments exactly match the discovered set. No unrelated Export/compiler-prerequisite tests or held controls ran. No original test entrypoint/configuration or alternate acceptance harness was used.

  Compiler prerequisites were consumed through their owners, preserving assertions: matched lock repair `bd3dbde7939dc95c81cef4ab6b50f883459ee85d` (49/49 package-input preimages, own SDK 10.0.401 audit-on locked restore PASS); four bootstrap literals from `f53b6b79f8cf051bd190cad2e49a57ea4a1cc1bd`; original poll-field repair `e724251e44222c1c36388984f71f88e901a02c48`; only necessary existing master import/declaration/call-contract hunks from `57886f75213bd22c0dd3a8e2586073bdbdd97778`; and the original-owner two-line no-embed-plan fixture constructor repair `1ec04f0fef46b4c66337c2c95295e4b6c090d99c`, whose direct parent exactly matched `6baf73bbe6f3a05b198dad4d25c882fec7ece79d`. That last source was fast-forwarded unchanged, and every other source byte/assertion matched its parent. Supplier restore/build results were not transferred as this candidate's test acceptance. Earlier failed preflights remain historical diagnostics, not current blockers.
- [x] Targeted frontend checks: PASS on unchanged module source `7d23fc30865a206de0b31df527a6b6e59cd7c932` (not rerun for backend-only prerequisites): 20/20 component controls, 23/23 original HTML-sink hook controls, and public-page-manifest check. Exact `vitest list --config vitest.config.ts ../../tests/frontend/unit/components/admin/ArticlePackageCandidateReview.test.ts --json` preflight asserted exactly one nonempty file, 20 unique controls and the original hook's 23 unique fixtures before `npm run test:unit:fast -- ../../tests/frontend/unit/components/admin/ArticlePackageCandidateReview.test.ts`. No include/config changes or empty-selection fallback.
- [x] Other on module source `7d23fc30865a206de0b31df527a6b6e59cd7c932`: `dotnet build src/backend/FsusBlog.Server.csproj --no-restore` PASS (0 errors, 322 warnings outside the new projection/DTO); `npm run typecheck:local-fsusui` PASS on the final candidate; repository strict frontend style check on the two new source files, ordinary frontend layout check, targeted shared/backend C# whitespace verification, final title/message validation, and `git diff --check 08787f22f038569e893d6d1a4923aebc5b6bbe0f..HEAD` PASS.

Component controls cover accurate labels and unknown counts, create/update assertions, no execute emission, 0/1/1000 review states, malformed/overbudget read fields, Int64 strings, stale/refusal states, digest-bound pagination, native button semantics, live regions and focus through loading/error/replacement. These are ordinary component tests, not rendered browser or independent UX acceptance.

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

Matching proposed label: `release-note:added`; no PR or label has been created by this task. The source module is currently unmounted and is not an active product route.

## Generated Output

- Generator source: none
- Generated outputs: none
- Digest/evidence: none
- Automation identity: none

## Rollout / Rollback

- Rollout: original owner consumes the real six-path source candidate, consumes the complete source and matched canonical compiler prerequisites with this candidate’s actual selected test results, then performs the remaining owner integration acceptance. Owner separately supplies authenticated route and permission projection. No production rollout performed.
- Rollback: exclude or revert this unmounted six-path module before integration; no business data, database, planner or route state has changed.
- Deferred work: full export, intake, compatible target/unknown resolution, executor, receipts/results/recovery center, authenticated read transport, permission projection and rendered independent UX acceptance.
- Known limitations: 0-article plans are rejected by the original codec; the component's empty state means no supplied candidate. Assets/unresolved counts are explicitly unknown. Caller interval status does not establish current store, actor permission, policy or target validity. Initial lock/compiler failures were resolved through exact owner prerequisites. Current original discovery and execution PASS at 18/18. Whole-project warnings and historical source style diagnoses are not claimed fixed; no whole-project strict-style acceptance is claimed. This does not complete #2406 or #2418.

## Notes For Reviewers

The module delivery branch changes only the six expressly released new paths. Its planner, registry, DI, HTTP/API entrypoints, historical metadata mapping, existing tests/configuration and integration branch are untouched. The separate verification branch additionally consumes only the explicitly authorized original-owner compiler prerequisites and records the ordinary diagnostics described above. The published delivery branch is based on the specified integrated base; its two commits have supported scopes and Refs footers. An earlier separate WIP source branch was published before completion; consume the delivery branch/SHA named above. No published history was rewritten, no integration ref was pushed/reset, and no GitHub content writes, PR merge, deployment, migration or package publication occurred.

The actual issue bodies and planner source were inspected. DTO documentation and this WIP body record the source/permission/transport boundaries and integration gaps. Public API documentation update is not applicable beyond the documented additive DTO: no public route, AEDS schema, ABI or database contract is added. No current design authority or documentation lifecycle file is changed within the exclusive-path release. Historical handoff archiving and generated-document updates are not applicable; no such artifacts are introduced. TODO/FIXME review is not applicable: none is added. Broad format-only work and blame-ignore revision updates are not applicable: every module/test path is new and there is no existing-file mechanical reformat. These reasons support the not-applicable review checkboxes above without claiming additional implementation.

Active local FsusUI source resolves through the repository resolver to `/workspace/FsusUI`, HEAD `b17077f3afd4a80ff3bdc0fe81d5dfc353ffddf2`, with clean tracked state. Applied both repository design skills, task/status surface rules, public Button and spacing contracts. Product composition stays in FsusBlog with public FsusUI controls/tokens and no private selectors or component geometry overrides. No independent UX receipt or rendered conformance is claimed. Existing original-owner test controls or preceding package heads provide no acceptance for this candidate. No issue is closed by this source delivery.

Follow-up evidence: /tmp/article-package-review-nu1004-delta.json, /tmp/article-package-review-canonical-lock-input-match.json, /tmp/article-package-review-canonical-locked-restore.log, /tmp/article-package-review-canonical-backend-discovery.log and /tmp/article-package-review-backend-followup.json. Existing frontend results were not rerun. The original module branch and original project/lock source remain clean and unchanged.

Latest tested source: `1ec04f0fef46b4c66337c2c95295e4b6c090d99c` on `article-package-review-backend-verification-20261009-0810`. Beyond the unchanged module, the full compiler-prerequisite scope is one existing lock file (`tests/backend/packages.lock.json`) and eight existing test files: `LifecycleHostedBootstrapServiceTests.cs`, `AuthoringExtensionRpcBrokerTests.cs`, `TaxonomyExactMetadataTests.cs`, `SecurityAdminPolicyDefaultsTests.cs`, `RealConcurrencyHarnessTests.cs`, `DocumentExportContractTests.cs`, `CanonicalArticleLifecycleScheduledFailureTests.cs` and `CanonicalArticleProjectionVerifierTests.cs`, all under `tests/backend/Unit/`. Only the already published minimal compiler hunks were consumed; original assertions were preserved. No broader package-owner source or unrelated master tests were imported.

Current artifacts include `positive-discovery.json` with the exact 18 names/arguments, `resource-preflight.json`, `owner-constructor-consumption.json` with exact preimages, `execution-summary.json`, original output archived as `test-run.txt`, ordinary TRX XML archived as `projection-results.xml`, and the full repository-template WIP body. Earlier failed discovery and compiler/lock provenance are retained as historical information. All are under `artifacts/article-packages/candidate-review-backend-verification-20261009/`. Current module/compiler/test input blockers: none. Frontend results remain bound to unchanged module source without rerun. Authenticated route/permission integration, full export/intake/resolution/executor/results flow and rendered independent UX acceptance remain explicitly deferred.

The original logger outputs remain at `/tmp/article-package-review-projection-results/article-package-review-projection.trx` and `/tmp/article-package-review-owner-constructor-tests.log`. Their published `.xml`/`.txt` copies preserve every byte and respect the repository’s ignored `.trx`/`.log` extensions; no logger, test include or configuration changes were made.
