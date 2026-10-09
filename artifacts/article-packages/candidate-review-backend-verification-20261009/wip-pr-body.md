## Linked Issue

Refs #2406

Related unfinished scope: [#2418](https://github.com/Ozwasyd/FsusBlog/issues/2418). Original package planner and integration ownership remain with [#3663](https://github.com/Ozwasyd/FsusBlog/issues/3663).

## Scope Summary

- WIP read-only module from integrated base `08787f22f038569e893d6d1a4923aebc5b6bbe0f`, delivered at `7d23fc30865a206de0b31df527a6b6e59cd7c932` on `article-package-candidate-review-delivery-20261009-0753`.
- Six new released paths only: shared `ArticlePackageImportCandidateReviewContracts.cs`, backend `ArticlePackageImportCandidateReviewProjection.cs`, backend `ArticlePackageImportCandidateReviewProjectionTests.cs`, frontend `articlePackageCandidateReview.ts`, Vue `ArticlePackageCandidateReview.vue`, and dedicated ordinary component test `tests/frontend/unit/components/admin/ArticlePackageCandidateReview.test.ts`.
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
- [ ] Targeted backend tests: UNRUN. Initial NU1004 was resolved only in the separate verification checkout by consuming canonical lock repair `bd3dbde7939dc95c81cef4ab6b50f883459ee85d`, whose 49/49 package-input preimages matched. SDK 10.0.401 audit-on locked restore PASSed. Four original-owner bootstrap InlineData literal repairs were consumed from `f53b6b79f8cf051bd190cad2e49a57ea4a1cc1bd` after matching the exact preimage, without changing methods/assertions/runtime code. The next discovery identified 16 errors in seven other test files. This follow-up read-only compared their actual preimages and dependencies against master `57886f75213bd22c0dd3a8e2586073bdbdd97778`. It cherry-picked only the original poll-field repair `e724251e44222c1c36388984f71f88e901a02c48` and consumed only the necessary master import/declaration/call-contract hunks, preserving all assertions and excluding master’s unrelated tests or formatting. Published verification source is `2215f1f3fd7988ab4be2b8560b60f8d0496aea56` on `article-package-review-backend-verification-20261009-0810`. Current original discovery FAILed (exit 1) with only two CS7036 diagnostics in DocumentExportContractTests.cs:284/991; 14 of the previous 16 diagnostics were eliminated by these actual existing fixes; the current actual frozen-input contract requires `DocumentExportFrozenEmbeds? FrozenEmbeds` before `ContentDigest`, a parameter absent from that master and its two old test call sites. Original-owner exact call-site hunk or narrow explicit authorization is requested. No unrelated prerequisite tests, held controls or projection tests have executed. The source declaration is 8 facts + 10 inline cases = 18; actual nonempty 18-case discovery must still succeed before execution. No alternate harness or test entrypoint/config change was used.
- [x] Targeted frontend checks: PASS on the final delivery candidate: 20/20 component controls, 23/23 original HTML-sink hook controls, and public-page-manifest check. Exact `vitest list --config vitest.config.ts ../../tests/frontend/unit/components/admin/ArticlePackageCandidateReview.test.ts --json` preflight asserted exactly one nonempty file, 20 unique controls and the original hook's 23 unique fixtures before `npm run test:unit:fast -- ../../tests/frontend/unit/components/admin/ArticlePackageCandidateReview.test.ts`. No include/config changes or empty-selection fallback.
- [x] Other: `dotnet build src/backend/FsusBlog.Server.csproj --no-restore` PASS on the final candidate (0 errors, 322 warnings outside the new projection/DTO); `npm run typecheck:local-fsusui` PASS on the final candidate; repository strict frontend style check on the two new source files, ordinary frontend layout check, targeted shared/backend C# whitespace verification, final title/message validation, and `git diff --check 08787f22f038569e893d6d1a4923aebc5b6bbe0f..HEAD` PASS.

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

- Rollout: original owner consumes the real six-path source candidate, consumes the matched canonical compiler prerequisites, resolves the remaining frozen-input call-site signature delta through its owner, then runs the actual selected tests before integration acceptance. Owner separately supplies authenticated route and permission projection. No production rollout performed.
- Rollback: exclude or revert this unmounted six-path module before integration; no business data, database, planner or route state has changed.
- Deferred work: full export, intake, compatible target/unknown resolution, executor, receipts/results/recovery center, authenticated read transport, permission projection and rendered independent UX acceptance.
- Known limitations: 0-article plans are rejected by the original codec; the component's empty state means no supplied candidate. Assets/unresolved counts are explicitly unknown. Caller interval status does not establish current store, actor permission, policy or target validity. Initial NU1004 is resolved by the matched canonical prerequisite; the four bootstrap-test CS0182 errors have also been removed by the authorized constants; the next 16 diagnostics were addressed through existing exact master/compiler hunks, except the two current FrozenEmbeds call-site gaps absent from that master; final original discovery FAILed with only those two CS7036 diagnostics and projection controls remain unexecuted. This does not complete #2406 or #2418.

## Notes For Reviewers

The module delivery branch changes only the six expressly released new paths. Its planner, registry, DI, HTTP/API entrypoints, historical metadata mapping, existing tests/configuration and integration branch are untouched. The separate verification branch additionally consumes only the explicitly authorized original-owner compiler prerequisites and records the ordinary diagnostics described above. The published delivery branch is based on the specified integrated base; its two commits have supported scopes and Refs footers. An earlier separate WIP source branch was published before completion; consume the delivery branch/SHA named above. No published history was rewritten, no integration ref was pushed/reset, and no GitHub content writes, PR merge, deployment, migration or package publication occurred.

The actual issue bodies and planner source were inspected. DTO documentation and this WIP body record the source/permission/transport boundaries and integration gaps. Public API documentation update is not applicable beyond the documented additive DTO: no public route, AEDS schema, ABI or database contract is added. No current design authority or documentation lifecycle file is changed within the exclusive-path release. Historical handoff archiving and generated-document updates are not applicable; no such artifacts are introduced. TODO/FIXME review is not applicable: none is added. Broad format-only work and blame-ignore revision updates are not applicable: every module/test path is new and there is no existing-file mechanical reformat. These reasons support the not-applicable review checkboxes above without claiming additional implementation.

Active local FsusUI source resolves through the repository resolver to `/workspace/FsusUI`, HEAD `b17077f3afd4a80ff3bdc0fe81d5dfc353ffddf2`, with clean tracked state. Applied both repository design skills, task/status surface rules, public Button and spacing contracts. Product composition stays in FsusBlog with public FsusUI controls/tokens and no private selectors or component geometry overrides. No independent UX receipt or rendered conformance is claimed. Existing original-owner test controls or preceding package heads provide no acceptance for this candidate. No issue is closed by this source delivery.

Follow-up evidence: /tmp/article-package-review-nu1004-delta.json, /tmp/article-package-review-canonical-lock-input-match.json, /tmp/article-package-review-canonical-locked-restore.log, /tmp/article-package-review-canonical-backend-discovery.log and /tmp/article-package-review-backend-followup.json. Existing frontend results were not rerun. The original module branch and original project/lock source remain clean and unchanged.

Latest prerequisite source: `2215f1f3fd7988ab4be2b8560b60f8d0496aea56` on `article-package-review-backend-verification-20261009-0810`. Its delta beyond module `7d23fc30865a206de0b31df527a6b6e59cd7c932` consists of the matched one-line lock prerequisite, four authorized bootstrap literals, original poll-field repair, six minimal master compiler-fix files and ordinary compilation/provenance diagnostics. The module itself remains unchanged. No unrelated test additions, assertions or product runtime were imported. Remaining known signature gap: `tests/backend/Unit/DocumentExportContractTests.cs:284,991` lacks the now-required nullable FrozenEmbeds argument between ReadingStyleAuthorityDigest and ContentDigest. The master snapshot has no applicable hunk for this actual integrated signature.

Current ordinary compiler diagnostics, exact preimages, master-consumption hunks and full repository-template WIP body are published under `artifacts/article-packages/candidate-review-backend-verification-20261009/`. Final discovery is FAIL (2 errors / 1 file), 18 projection controls UNRUN (0 discovered/executed), unchanged frontend results are retained without rerun. No exact-owner FrozenEmbeds call-site hunk or explicit narrow authorization has been supplied yet.
