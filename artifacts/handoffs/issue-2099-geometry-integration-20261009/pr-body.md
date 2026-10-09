## Linked Issue

Refs #2099

Related to [#2097](https://github.com/Ozwasyd/FsusBlog/issues/2097), [#2098](https://github.com/Ozwasyd/FsusBlog/issues/2098) and [#1894](https://github.com/Ozwasyd/FsusBlog/issues/1894). This is a proposed **draft/WIP**, not whole-issue acceptance. Parent is the sole GitHub content writer; this file has not been submitted through a PR/comment/label API.

## Scope Summary

The ordinary viewport catalog lacked the required 375 and 768 boundary records. This candidate preserves the supplied canonical composition contracts, analyzer and geometry component and combines them with the existing viewport catalog increment and focused refusal controls. The new geometry component compares exact DOM/geometry correspondence and positive visible primary-content intersection; its real browser capture entry refuses pending runtime state admission before either page evaluation.

Published source branch: `codex/issue-2099-geometry-integration-20261009`.
Published and actually tested head: `e95c5c8b2e9503ef6735e1ebb9c320c55964ad4e`.
Fetched master: `c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f`.
PR merge-base: `0e9dd5751bdd584204fd149bdb1526b97ff682a6`.

The full cumulative PR delta is **123 files, 17924 insertions and 1833 deletions**. It includes supplied ancestry with existing control-legality, locale-menu, image-viewer/comment-composer, plugin and composition work, lockfiles, generated documents, screenshot/log artifacts and prior qualification records. Those inherited records retain their original bindings; they have not been rerun, relabeled or qualified by this source integration. The complete roster is below. This candidate is not represented as a two-file geometry PR.

### Exact released provenance and own delta

- Released composition input/analyzer source: `2c688e912067e08069f3c98ee42a963071864263`.
- Released geometry component: `7499b5bd82d3ce888672abc2e054bb08736da08d`, direct child of that source. Both component files remain byte-identical.
- Own viewport source `ec09353b19d25d3eae4e315afdd8f99c53ff5653` incorporated as `480d626460472892ee287eba7ccf70715763ead6`.
- Own naming correction `7a9d30c4bc57b449241930422f6ca19a9d0727eb` incorporated as `c5d5f1d7792b1128f39fa9d88b37e5ce82f667c5`.
- New docs-only integration-limit commit: `e95c5c8b2e9503ef6735e1ebb9c320c55964ad4e`.

The delta from the supplied geometry commit is four files, 77 insertions and 5 deletions: the naming manifest, `docs/testing.md`, `ux-viewport-matrix.json` and `ux-viewport-plan.test.mjs`. The combined delta from supplied `2c688e9` is six files, 539 insertions and 5 deletions. No sibling PR was merged and no later master rebase or cross-chain conflict resolution was performed.

The older `7a9d30c` viewport branch remains frozen. The canonical archetype matrix retains `2c688e9` blob `2fe92f9c9d37f3e8ecc605ca12b2ec229bb67aa2`; the older #2097 blob `a6148df0ff549810bf13e652e3ac744c2cf8e51e` was not overlaid.

## Change Classification

- [x] Behavior change
- [ ] Format-only
- [ ] Naming-only
- [x] Generated output
- [x] Public contract change
- [x] External naming exception
- Contract impact: compatible

Classification describes the full inherited draft scope. Full generated-output, public-contract and naming admission remains pending; these checkboxes do not assert the full contract checker passed. The new own increment does not regenerate outputs or alter geometry component APIs.

## Tests Run

- [ ] `./tools/test.sh fast`
- [ ] Targeted backend tests
- [x] Targeted frontend checks: exact 25 ordinary controls, zero failed/skipped/extra; exit0 at the published source head, Node24.16.0. Four `node --check` commands passed.
- [x] Other: two JSON parse checks, own `git diff --check`, own three-commit range checker and actual docs lint exit0.

**Failed:** scoped frontend changed-owner style exited1 with 349 diagnostics, all reported in `tests/tools/ux-viewport-plan.test.mjs`. Neither supplied geometry file reported a diagnostic in that same invocation. No fixer, baseline allowance or shared policy change was applied. This remains a failed gate.

**Not run:** full123-file PR metadata/generated/naming admission, inherited source/runtime suites, current product scenes, browser capture, native zoom/font/render/accessibility/local-published observations, or held identity/receipt/audit qualification. No source control or inherited screenshot is treated as current product acceptance.

### Exact ordinary command

```bash
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI \
/workspace/FsusBlog/.tmp/issue-3576-20261008/node-24.16.0/node-v24.16.0-linux-x64/bin/node \
--test --test-reporter=tap tests/tools/ux-viewport-plan.test.mjs tests/tools/layout-composition-geometry.test.mjs
```

The preflight inspected the exact 12 planner and 13 geometry cases and their imports before execution. There are no test hooks; the imported planner progress CLI main guard does not execute its broader suite. Numeric geometry controls are controlled source-comparison observations, not product DOM/fixture/browser receipts. The actual pending-input control proves refusal with zero page evaluations. The original TAP has exactly the allowed case-name multiset; Node's file emission order differs from CLI argument order, which is not an acceptance criterion. No tests were rerun to repair that accounting assumption.

Local official locked installations used `npm ci --ignore-scripts` for the schema validator, frontend support package and frontend style toolchain. Installation commands and results are retained. The first docs checker attempt used unsupported `--operation check` and exited1 before lint; its original log is retained. The corrected actual `--operation lint --require-tools` invocation passed.

### Public execution evidence

- [Handoff and command results](handoff.json)
- [Raw TAP](ordinary-tests.tap), [exact membership](case-membership.json), [preflight](preflight.json), [command](test-command.json), [result](test-result.json)
- [Failed style log](frontend-style.log), [style command/result](frontend-style-result.json), [diagnostic counts](frontend-style-summary.json)
- [Syntax/JSON/diff checks](syntax-and-diff-checks.json), [commit range](commit-range-result.json), [valid docs lint](docs-style-result.json)
- [Component/matrix/Node byte bindings](source-bindings.json), [remote SHA readback](source-remote-verification.json)
- [Existing caller gap](caller-boundary.json), [actual input gaps](current-input-gaps.json), [all41 assignment accounting](assignment-status-update.json)

## UI Evidence

- [ ] Current screenshots or video
- [ ] Mobile layout checked in an actual browser
- [ ] Dark mode checked in an actual browser
- [ ] Accessibility and reduced-motion product acceptance

375x812 and 768x1024 are catalog/planner coverage only. The existing `zoom-*` media helper uses CSS zoom and does not satisfy native browser zoom. Supplied historical screenshot/probe artifacts in the full ancestry are listed below but are not current-run evidence for this candidate.

## Coding Convention

- [ ] C# mother-style mapping reviewed for the entire inherited scope
- [x] Formatter/linter run
- [x] No tool default overrides repository style
- [x] Mechanical formatting separated from logic
- [ ] `.git-blame-ignore-revs` updated when applicable

- Formatter identity: none
- Formatter version: none
- Formatter command: none
- Formatter idempotence evidence: none
- Blame-ignore revision: none

No mechanical migration was performed; a separately governed source-format step is required to clear the failed style gate. A lint execution checkbox does not assert success.

## External Naming Exception

- Exceptions manifest: artifacts/change-contract/issue-2099-viewport-source-external-naming.json

This manifest intentionally covers only the own changed registered viewport matrix surface. **It is not claimed to cover the union of all registered surfaces in the inherited123-file PR.** Additional supplied manifests and generated bindings are present in the roster; complete trusted-base contract admission is not run/accepted. Parent/metadata owners must decide the cumulative contract metadata before the draft can qualify.

## Documentation / Intent

- [ ] Public API docs reviewed for full inherited scope
- [x] Ownership and integration limits documented in current `docs/testing.md`
- [x] Historical handoff archived with original candidate bindings
- [x] TODO/FIXME references valid issues

## Compatibility And Risk

- [x] Cross-language coding conventions reviewed for the focused source increment
- [x] Stable integration facts are current; evidence is an issue handoff
- [x] Own viewport wire names preserved
- [ ] Public API impact reviewed for full inherited scope
- [ ] AEDS/binary impact reviewed for full inherited scope
- [ ] Database impact reviewed for full inherited scope
- [ ] Security/auth/moderation/PoW/privacy impact reviewed for full inherited scope
- [x] Focused source limits documented
- [x] Known limitations retained

No production, migration, credentials, deployment or destructive resource work was performed.

## Performance Claim

- Claim level: none
- Evidence path: none
- Non-goals: no performance qualification

## Release Note

- Audience: internal
- Category: Internal/Tooling
- Summary: combine released composition geometry diagnostics

Proposed title: `test(frontend): combine released composition geometry diagnostics`. Parent owns any matching label/API write.

## Generated Output

- Generator source: pending full inherited-scope metadata review
- Generated outputs: inherited roster below; no new own generated output
- Digest/evidence: supplied manifests retain original bindings; full cumulative admission not run
- Automation identity: none

## Rollout / Rollback

- Rollout: source branch and draft review only; no deployment or merge
- Rollback: discard this isolated candidate; old viewport branch and supplied component commits remain intact
- Deferred work: legitimate scene/state/fixture/baseline/current run/source bindings and original product acceptance
- Known limitations: all below remain blocking whole-issue acceptance

The real canonical input has12 archetypes,91 pending-current-run states and79 null fixture refs. Authoring capability #1814 and control-origin capability #1895 still await exact commits. No admission facts or fixture markup are synthesized.

The existing viewport caller at `tests/frontend/e2e/ux/viewport-boundaries.spec.ts:815` invokes `assertViewportBoundaryContract(session.page, label)`. Its planner at line141 supplies the legacy route/theme/viewport/media matrix; it has no canonical archetype/state admission, current verified fixture/terminal-ready proof, baseline/current composition identity or exact run/source binding. Therefore no legitimate geometry probe insertion was made in this old caller.

The real diagnostic analyzer hook at `tests/frontend/checks/runtime/check-layout-composition-probe.mjs:205` belongs to #1894 and currently calls `probeCompositionPage` with a controlled diagnostic candidate. `compositionAnalyzerSources` at `tests/frontend/support/layout/compositionAnalyzer.mjs:9` excludes geometry and remains unchanged under its existing owner. Any future analyzer integration must use the **exact `domObservation` returned by `probeCompositionGeometryPage`**, rather than recapture and assume correspondence. The probe's two captures are sequential rather than atomic; correspondence drift refuses.

The coordinator has assigned independent chrome, flow-order and overflow predicate workers on the supplied geometry base. Their exact published commits have not yet been supplied to this caller task; no predicate implementation is duplicated here. Future consumption requires their exact released identity and a matching canonical contract. Unknown or unimplemented predicates remain explicit pending work, and the analyzer source roster remains owned by #1894.

`fullGeometryVerified`, `fullVisualVerified`, whole #2099 acceptance and whole41 assignment acceptance remain false. Tracking parents receive accounting only. Original #3576/current other issue receipts retain their earlier tested SHAs; this attempt does not rerun or promote them.

## Notes For Reviewers

This proposed full WIP body is intentionally not described as contract-green: the style gate is failed and the full inherited metadata, runtime, product, generated and cross-owner gates remain unresolved. GitHub content operations are reserved to the parent. No issue is closed, PR merged, auto-merge enabled or master pushed.

### Complete cumulative PR roster

Added/removed values are from the actual merge-base diff, not a two-tree master comparison. `- / -` denotes binary changes.

| Path | Added / removed |
|---|---:|
| `artifacts/change-contract/control-integration-external-naming.json` | 41 / 0 |
| `artifacts/change-contract/control-legality-external-naming.json` | 32 / 0 |
| `artifacts/change-contract/control-legality-generated-binding.json` | 12 / 0 |
| `artifacts/change-contract/issue-1892-external-naming-exceptions.json` | 12 / 0 |
| `artifacts/change-contract/issue-2099-viewport-source-external-naming.json` | 10 / 0 |
| `artifacts/frontend/locale-menu-probe/error-retry.png` | - / - |
| `artifacts/frontend/locale-menu-probe/generated-binding.json` | 31 / 0 |
| `artifacts/frontend/locale-menu-probe/local-probe.json` | 88 / 0 |
| `artifacts/frontend/locale-menu-probe/menu-alternative.png` | - / - |
| `artifacts/frontend/locale-menu-probe/migration/README.md` | 59 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/binding.json` | 223 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/blog-unit.log` | 14 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/broader-consumer-typecheck.log` | 293 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/build.log` | 79 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/consumer-1440-dark-zoom1.png` | - / - |
| `artifacts/frontend/locale-menu-probe/migration/consumer-375-dark-zoom2.png` | - / - |
| `artifacts/frontend/locale-menu-probe/migration/consumer-375-light-zoom1.png` | - / - |
| `artifacts/frontend/locale-menu-probe/migration/error-retry.png` | - / - |
| `artifacts/frontend/locale-menu-probe/migration/export-typecheck.log` | 10 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/fsusui-377d0a88-introduced-type-error.log` | 9 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/fsusui-baseline-web-typecheck.log` | 8 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/fsusui-unit.log` | 9 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/fsusui-web-typecheck.log` | 8 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/implementation-start-classification.json` | 49 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/layout.log` | 1 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/local-command.log` | 147 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/local-probe.json` | 182 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/menu-alternative.png` | - / - |
| `artifacts/frontend/locale-menu-probe/migration/pending.png` | - / - |
| `artifacts/frontend/locale-menu-probe/migration/published-command.log` | 8 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/published-probe.json` | 26 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/selector-typecheck.log` | 0 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/style.log` | 1 / 0 |
| `artifacts/frontend/locale-menu-probe/migration/upstream-implementation-start-classification.json` | 81 / 0 |
| `artifacts/frontend/locale-menu-probe/pending.png` | - / - |
| `artifacts/frontend/locale-menu-probe/published-install.txt` | 8 / 0 |
| `artifacts/frontend/locale-menu-probe/published-probe.json` | 25 / 0 |
| `benchmarks/core/packages.lock.json` | 7 / 0 |
| `config/frontend/control-legality.json` | 4 / 0 |
| `config/schemas/layout-composition-contract.schema.json` | 1386 / 0 |
| `docs/frontend/layout-visual-governance.md` | 180 / 0 |
| `docs/frontend/motion-guidelines.md` | 2 / 2 |
| `docs/i18n.md` | 14 / 0 |
| `docs/security/comment-draft-privacy.md` | 10 / 4 |
| `docs/testing.generated.md` | 10 / 5 |
| `docs/testing.md` | 2 / 0 |
| `package.json` | 14 / 0 |
| `src/frontend/src/components/article/ArticleCommentComposer.vue` | 273 / 308 |
| `src/frontend/src/components/article/ArticleImageLightbox.vue` | 32 / 175 |
| `src/frontend/src/components/i18n/LocaleSelectorRuntimeAdapter.vue` | 2 / 0 |
| `src/frontend/src/components/i18n/useLocaleSelectorRuntime.ts` | 15 / 1 |
| `src/frontend/src/components/ui/LocaleSelector.vue` | 143 / 624 |
| `src/frontend/src/components/ui/localeSelectorTypes.ts` | 2 / 0 |
| `src/frontend/src/composables/article/useArticleImageLightbox.ts` | 2 / 11 |
| `src/frontend/src/fsusui/README.md` | 32 / 1 |
| `src/frontend/src/fsusui/checkbox.ts` | 2 / 0 |
| `src/frontend/src/fsusui/input.ts` | 2 / 0 |
| `src/frontend/src/views/admin/PluginAdmin.vue` | 70 / 54 |
| `tests/backend/packages.lock.json` | 1 / 0 |
| `tests/frontend/README.md` | 24 / 0 |
| `tests/frontend/checks/runtime/check-layout-composition-probe.mjs` | 290 / 0 |
| `tests/frontend/checks/runtime/check-plugin-collection-probe.mjs` | 547 / 0 |
| `tests/frontend/checks/runtime/probe-article-image-lightbox.mjs` | 229 / 0 |
| `tests/frontend/checks/runtime/probe-image-viewer-consumer.mjs` | 358 / 0 |
| `tests/frontend/checks/runtime/probe-locale-menu.mjs` | 431 / 0 |
| `tests/frontend/checks/static/check-article-image-lightbox-overlay.mjs` | 69 / 288 |
| `tests/frontend/checks/static/check-fsusui-boundary-fixture.mjs` | 12 / 0 |
| `tests/frontend/checks/static/check-fsusui-boundary.mjs` | 42 / 1 |
| `tests/frontend/checks/static/check-layout-composition.mjs` | 44 / 0 |
| `tests/frontend/checks/static/check-public-reading-motion.mjs` | 5 / 10 |
| `tests/frontend/checks/static/check-views-constraints.mjs` | 12 / 1 |
| `tests/frontend/e2e/article-comment-composer-primitives.spec.ts` | 184 / 0 |
| `tests/frontend/e2e/ux/viewport-boundaries.spec.ts` | 5 / 5 |
| `tests/frontend/fixtures/articleCommentComposer.ts` | 97 / 0 |
| `tests/frontend/fixtures/imageViewerConsumerProbe.ts` | 112 / 0 |
| `tests/frontend/fixtures/layout-archetype-matrix.json` | 3951 / 17 |
| `tests/frontend/fixtures/localeMenuProbe/App.vue` | 117 / 0 |
| `tests/frontend/fixtures/localeMenuProbe/Consumer.vue` | 53 / 0 |
| `tests/frontend/fixtures/localeMenuProbe/README.md` | 70 / 0 |
| `tests/frontend/fixtures/localeMenuProbe/index.html` | 12 / 0 |
| `tests/frontend/fixtures/localeMenuProbe/main.ts` | 5 / 0 |
| `tests/frontend/fixtures/pluginCollectionProbe/PluginCollectionProbe.vue` | 278 / 0 |
| `tests/frontend/fixtures/pluginCollectionProbe/index.html` | 12 / 0 |
| `tests/frontend/fixtures/pluginCollectionProbe/main.ts` | 7 / 0 |
| `tests/frontend/fixtures/ux-viewport-matrix.json` | 28 / 0 |
| `tests/frontend/package-lock.json` | 39 / 0 |
| `tests/frontend/package.json` | 5 / 1 |
| `tests/frontend/support/layout/compositionAnalyzer.mjs` | 132 / 0 |
| `tests/frontend/support/layout/compositionContracts.mjs` | 480 / 0 |
| `tests/frontend/support/layout/compositionDom.mjs` | 446 / 0 |
| `tests/frontend/support/layout/compositionGeometry.mjs` | 196 / 0 |
| `tests/frontend/support/layout/compositionRoutes.mjs` | 325 / 0 |
| `tests/frontend/support/layout/compositionSource.mjs` | 1266 / 0 |
| `tests/frontend/support/playwright/acceptance-shared.ts` | 9 / 14 |
| `tests/frontend/typecheck/article-comment-composer-consumer-contract.ts` | 24 / 0 |
| `tests/frontend/typecheck/fsusui-export-contract.ts` | 1 / 0 |
| `tests/frontend/unit/components/ArticleCommentComposer.test.ts` | 243 / 19 |
| `tests/frontend/unit/components/ArticleImageLightbox.test.ts` | 64 / 203 |
| `tests/frontend/unit/components/LocaleSelector.test.ts` | 93 / 71 |
| `tests/frontend/unit/components/LocaleSelectorRuntimeAdapter.test.ts` | 57 / 4 |
| `tests/frontend/unit/views/PluginAdminCollection.test.ts` | 139 / 0 |
| `tests/governance/frontend-test-layout.json` | 1 / 0 |
| `tests/matrix.yml` | 6 / 6 |
| `tests/tools/control-legality.test.mjs` | 279 / 0 |
| `tests/tools/layout-component-guards-source.test.mjs` | 70 / 0 |
| `tests/tools/layout-component-props-source.test.mjs` | 172 / 0 |
| `tests/tools/layout-composition-contracts.test.mjs` | 496 / 0 |
| `tests/tools/layout-composition-geometry.test.mjs` | 266 / 0 |
| `tests/tools/layout-composition-source.test.mjs` | 327 / 0 |
| `tests/tools/layout-factory-source.test.mjs` | 142 / 0 |
| `tests/tools/package-lock.json` | 22 / 1 |
| `tests/tools/package.json` | 3 / 1 |
| `tests/tools/ux-viewport-plan.test.mjs` | 37 / 5 |
| `tools/contracts/FsusBlog.AuthSessionObservation/packages.lock.json` | 7 / 0 |
| `tools/contracts/FsusBlog.ConfigErrorSecurityObservation/packages.lock.json` | 7 / 0 |
| `tools/contracts/FsusBlog.ContentLifecycleObservation/packages.lock.json` | 7 / 0 |
| `tools/contracts/FsusBlog.OpenApiObservation/packages.lock.json` | 7 / 0 |
| `tools/contracts/FsusBlog.RuntimeRoleObservation/packages.lock.json` | 74 / 0 |
| `tools/frontend/control-legality/admission.mjs` | 139 / 0 |
| `tools/frontend/control-legality/package-lock.json` | 23 / 0 |
| `tools/frontend/control-legality/package.json` | 13 / 0 |
| `tools/frontend/control-legality/source.mjs` | 1637 / 0 |
| `tools/package.json` | 5 / 1 |
