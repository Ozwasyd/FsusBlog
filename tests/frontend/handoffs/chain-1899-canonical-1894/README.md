# Canonical #1894/#2098 source handoff

Status: source-only handoff; all findings remain unresolved; qualificationEligible=false.

Canonical preparation writer: #1894/#2098. Chain #1899 supplies this proposal and does not write `check-layout-composition-probe.mjs`. Canonical #1895 owns resolver provenance/dataflow changes. Coordinate the writer through the parent; do not apply the same preparation change in multiple chains.

Analyzer source: `f695e38625f40ed5bcdc0c252948a5adaa16f063`; consumer source: `623f4627eb0f52bced2e40de8d20c49c68aede6a`; actual FsusUI: `f2b3bb89ffe5f749da26c388f058efdbb6aee864`.

Canonical matrix SHA-256: `5be1d6137497423690536407c5b27d73428173f14493df8fe015d86955ac03dd`. Keep Settings screenshotTarget `.settings-workspace` and all existing matrix semantics.

## Cold preparation reproduction and bounded proposal

The unchanged preparation prefix (only the execution-location repositoryRoot substitution needed for stdin) records `Failed to fetch dynamically imported module: http://127.0.0.1:5173/baseline.vue`. Network trace identifies these 504 `Outdated Optimize Dep` responses:

- `/@fs/tmp/chain-1899/static-source-f695/node_modules/.vite/deps/dayjs_plugin_isSameOrAfter__js.js?v=0c6b3735`
- `/@fs/tmp/chain-1899/static-source-f695/node_modules/.vite/deps/dayjs_plugin_isSameOrBefore__js.js?v=61d679bf`

The original preparation sets completed despite retaining runtimeErrors; the diagnostic wrapper exits 1 because of those errors. This is not a claim about the original full provider CLI exit code.

Proposed patch is `cold-preparation.patch`. It transforms the actual entry and lazy baseline before browser navigation, waits for Vite static requests, and refuses recorded runtime errors. It uses public Vite APIs and no fixed delay, dependency allowlist, private optimizer replacement or receipt changes.

| Preparation trace | Run ID | Exit | Outcome |
|---|---|---:|---|
| original-reproduction | `composition-dom-2026-10-08T08-00-57.555Z-7228d229-64a2-4242-816a-16d158c97db4` | 1 | failed-preparation; 191 request failures |
| candidate-1 | `composition-dom-2026-10-08T08-05-28.475Z-3e5883cb-173a-4085-ab24-0912daedee0a` | 0 | prepared; 0 request failures |
| candidate-2 | `composition-dom-2026-10-08T08-07-02.712Z-519ce3eb-03ef-4fea-a28b-e4020c19ffe1` | 0 | prepared; 0 request failures |
| negative-module-abort | `composition-dom-2026-10-08T08-10-21.840Z-805ce37d-1266-4bd8-9dd2-d59e3112edb9` | 1 | failed-preparation; 1 request failures |

Both candidate runs re-optimize from a changed isolated fixture config and each make 1245 real requests/responses with no HTTP/page/request errors. The negative aborts the actual baseline.vue request and still refuses the missing main after 30 seconds. Only preparation executes: no new synthetic receipt or production scene/adjudication is generated. Provider file SHA-256 remains `432937e58ea5bb9193b83574af45ef5f84582496480aa27aa37a8c17c99f9340`.

## Exact diagnosis ownership

282 occurrences group into 75 exact file/offset/reason/message findings, not 282 independent defects. Settings has 42 occurrences. No error was discarded, accepted or classified as a product-source defect merely because its file appears below.

| Classification | All occurrences | Unique positions | Settings | Repair owner |
|---|---:|---:|---:|---|
| route-use-sink | 24 | 8 | 2 | canonical #1894/#2098 composition analyzer |
| public-icon-export-star | 87 | 19 | 10 | canonical #1894/#2098 composition analyzer |
| vite-icons-alias | 15 | 7 | 5 | canonical #1894/#2098 composition analyzer, canonical #1895 resolver for shared module provenance |
| default-ts-tsx-render | 16 | 9 | 4 | canonical #1894/#2098 composition analyzer |
| finite-component-variants | 29 | 9 | 3 | canonical #1894/#2098 composition analyzer |
| router-view-slot | 12 | 2 | 1 | canonical #1894/#2098 composition route/DOM join; canonical #1895 resolver for slot provenance |
| markdown-provider-property | 2 | 1 | 1 | canonical #1895 source resolver; canonical #1894 composition consumer |
| registry-selected-icon | 1 | 1 | 0 | canonical #1895 source resolver; canonical #1894 source/state join |
| public-prop-component-default | 96 | 19 | 16 | canonical #1895 source resolver; canonical #1894 DOM/prop binding consumer |

### route-use-sink

Repair file/API: `tests/frontend/support/layout/compositionSource.mjs:routeBranch`.

Trace actual route.name reads through business/selection/identity consumers to visual layout sinks and bind current route/state. Keep true visual branch violations and unresolved dataflow failures; do not allowlist route reads.

### public-icon-export-star

Repair file/API: `tests/frontend/support/layout/compositionSource.mjs:exportComponent/componentFile`.

Follow runtime public export provenance including export-star barrels through the canonical #1895 resolver and actual Vite aliases. Explicit publicIdentity currently reaches icons-vue/dist/types/*.vue.d.ts, so the type declaration must not count as a runtime component source edge. Existing public @ozwasyd/element-plus/icons-vue Warning/Plus/Loading exports must resolve to actual Vue component nodes.

### vite-icons-alias

Repair file/API: `tests/frontend/support/layout/compositionSource.mjs:importFile`.

Consume the actual Vite alias/module resolution edge for @element-plus/icons-vue -> FsusUI/vue/packages/icons-vue/src/index.ts from src/frontend/scripts/fsusui-local.ts. Do not fabricate a missing upstream API or duplicate a guessed path map.

### default-ts-tsx-render

Repair file/API: `tests/frontend/support/layout/compositionSource.mjs:exportComponent/parse/graph`.

Resolve real TS ExportAssignment/default defineComponent factories through canonical AST and traverse TS/TSX render structure. Keep unsupported factories fail-closed. ElTabs resolves public identity to tabs.tsx#default already.

### finite-component-variants

Repair file/API: `tests/frontend/support/layout/compositionSource.mjs:parse dynamic component handling`.

Represent finite native/public component alternatives returned by canonical resolver and join selected alternative to actual DOM/state binding. LocaleSelector a/button is already returned as two native targets; do not accept unknown/open alternatives.

### router-view-slot

Repair file/API: `tests/frontend/support/layout/compositionSource.mjs + compositionRoutes.mjs; tools/frontend/control-legality/source.mjs:resolveExpression`.

Resolve Vue Router public RouterView v-slot Component provenance from the actual selected canonical route entry and runtime route state. Retain unknown route/slot failures; no hardcoded component replacement.

### markdown-provider-property

Repair file/API: `tools/frontend/control-legality/source.mjs:resolveExpression`.

Bounded AST return/property/guard dataflow from computed(resolveMarkdownEditorProvider) to sole markdownTextEditorProvider.editorComponent=requireComponent(MarkdownTextEditor). The concrete local SFC and public editor API exist. Preserve guard and runtime qualification.

### registry-selected-icon

Repair file/API: `tools/frontend/control-legality/source.mjs:resolveExpression`.

Track finite actual inspector registry icon provenance and bind selected view to current runtime state; retain unknown registry members as failures. Product selection/lease runtime remains canonical #2246 ownership.

### public-prop-component-default

Repair file/API: `tools/frontend/control-legality/source.mjs:resolveExpression; tests/frontend/support/layout/compositionSource.mjs:nativePropTargets`.

Project actual public Vue props/defaults, computed fallbacks and finite component maps. For open user-supplied icon/as/tag values require actual current prop/component identity and fail unknown; do not replace with guessed native tags or mark all diagnostics false positive.

## All 75 locations

Physical file ownership is Blog or FsusUI as shown by the prefix. It does not authorize changing that product/component source; the repair owner above owns analyzer/resolver work. Offsets are exact source positions at the commits above. Graph AST nodes and underlying source were read through the actual canonical resolver.

| Finding | Group | Physical file and line | Offset | Occurrences | Archetypes | Original reason/message |
|---|---|---|---:|---:|---|---|
| `5b5678d943c4b8e4` | route-use-sink | `FsusBlog/src/frontend/src/layouts/BlogLayout.vue:60` | 2440 | 5 | public/feed, public/reading, public/index, public/document, public/filter-search | `route-name-visual-branch` |
| `d41e5d2ef0a2622e` | route-use-sink | `FsusBlog/src/frontend/src/layouts/BlogLayout.vue:63` | 2519 | 5 | public/feed, public/reading, public/index, public/document, public/filter-search | `route-name-visual-branch` |
| `6081f05a122e4715` | router-view-slot | `FsusBlog/src/frontend/src/layouts/BlogLayout.vue:10` | 272 | 5 | public/feed, public/reading, public/index, public/document, public/filter-search | `[control-legality] /workspace/FsusBlog/src/frontend/src/layouts/BlogLayout.vue: unresolved component expression Component` |
| `bc188edc3b52bb03` | public-icon-export-star | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:66` | 2334 | 12 | public/feed, public/reading, public/index, public/document, public/filter-search, identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Loading` |
| `1c1d5fd7fe9c56a1` | finite-component-variants | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:78` | 2717 | 12 | public/feed, public/reading, public/index, public/document, public/filter-search, identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[composition-source] ambiguous dynamic component /workspace/FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:2717` |
| `a072f859bcdf0c27` | public-icon-export-star | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:117` | 4721 | 12 | public/feed, public/reading, public/index, public/document, public/filter-search, identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Loading` |
| `41f3cc7021d25474` | public-icon-export-star | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:122` | 4935 | 12 | public/feed, public/reading, public/index, public/document, public/filter-search, identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Check` |
| `ea611549d326956a` | public-icon-export-star | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:145` | 5804 | 12 | public/feed, public/reading, public/index, public/document, public/filter-search, identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Refresh` |
| `7652fb9a89c85a14` | public-icon-export-star | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:169` | 6703 | 12 | public/feed, public/reading, public/index, public/document, public/filter-search, identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Refresh` |
| `d03a69237c5f1d68` | public-prop-component-default | `FsusUI/vue/packages/motion/components/FsuMobileDock.vue:2` | 13 | 5 | public/feed, public/reading, public/index, public/document, public/filter-search | `[control-legality] /workspace/FsusUI/vue/packages/motion/components/FsuMobileDock.vue: unresolved component expression as` |
| `a3fc9c4cc25ec288` | public-prop-component-default | `FsusUI/vue/packages/components/button/src/button.vue:2` | 13 | 10 | public/feed, public/reading, public/document, identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[control-legality] /workspace/FsusUI/vue/packages/components/button/src/button.vue: unresolved component expression tag` |
| `9cbbaabd703bc345` | public-prop-component-default | `FsusUI/vue/packages/components/button/src/button.vue:30` | 836 | 10 | public/feed, public/reading, public/document, identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[control-legality] /workspace/FsusUI/vue/packages/components/button/src/button.vue: unresolved component expression loadingIcon` |
| `510a46f8501931d4` | public-prop-component-default | `FsusUI/vue/packages/components/button/src/button.vue:34` | 949 | 10 | public/feed, public/reading, public/document, identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[control-legality] /workspace/FsusUI/vue/packages/components/button/src/button.vue: unresolved component expression icon` |
| `3cc580f10ff32106` | public-icon-export-star | `FsusBlog/src/frontend/src/components/public/PublicArticleList.vue:87` | 3442 | 2 | public/feed, public/filter-search | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#ArrowRight` |
| `d1b43b67a3c93657` | public-prop-component-default | `FsusUI/vue/packages/components/input/src/input.vue:22` | 713 | 6 | public/reading, identity/identity-settings, identity/inbox-takeover, admin/collection, admin/form, admin/settings | `[control-legality] /workspace/FsusUI/vue/packages/components/input/src/input.vue: unresolved component expression prefixIcon` |
| `74b10f6311e45c5b` | public-prop-component-default | `FsusUI/vue/packages/components/input/src/input.vue:59` | 2006 | 6 | public/reading, identity/identity-settings, identity/inbox-takeover, admin/collection, admin/form, admin/settings | `[control-legality] /workspace/FsusUI/vue/packages/components/input/src/input.vue: unresolved component expression suffixIcon` |
| `ba6651d688b512aa` | finite-component-variants | `FsusUI/vue/packages/components/input/src/input.vue:74` | 2497 | 6 | public/reading, identity/identity-settings, identity/inbox-takeover, admin/collection, admin/form, admin/settings | `[composition-source] ambiguous dynamic component /workspace/FsusUI/vue/packages/components/input/src/input.vue:2497` |
| `c00c0161756c7504` | public-prop-component-default | `FsusUI/vue/packages/components/input/src/input.vue:87` | 3009 | 6 | public/reading, identity/identity-settings, identity/inbox-takeover, admin/collection, admin/form, admin/settings | `[control-legality] /workspace/FsusUI/vue/packages/components/input/src/input.vue: unresolved component expression validateState.value && ValidateComponentsMap[validateState.value]` |
| `5d59244be6c33b0e` | public-prop-component-default | `FsusUI/vue/packages/components/dialog/src/dialog-content.vue:17` | 531 | 8 | public/reading, identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[control-legality] /workspace/FsusUI/vue/packages/components/dialog/src/dialog-content.vue: unresolved component expression closeIcon &#124;&#124; Close` |
| `1bea52c33f974d87` | finite-component-variants | `FsusBlog/src/frontend/src/components/article/ArticleDetailHeader.vue:51` | 2017 | 1 | public/reading | `[composition-source] ambiguous dynamic component /workspace/FsusBlog/src/frontend/src/components/article/ArticleDetailHeader.vue:2017` |
| `4f5b990f8be84597` | finite-component-variants | `FsusBlog/src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue:153` | 5371 | 1 | public/reading | `[composition-source] ambiguous dynamic component /workspace/FsusBlog/src/frontend/src/components/public/pages/PublicArticleDetailPageContent.vue:5371` |
| `0492b67ba0b5541b` | default-ts-tsx-render | `FsusBlog/src/frontend/src/components/article/ArticleImageLightbox.vue:4` | 115 | 1 | public/reading | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/components/overlay/src/overlay.ts#default` |
| `48e15c7bd66b5cca` | public-prop-component-default | `FsusBlog/src/frontend/src/components/public/PublicReadingPageFrame.vue:2` | 15 | 2 | public/index, public/document | `[control-legality] /workspace/FsusBlog/src/frontend/src/components/public/PublicReadingPageFrame.vue: unresolved component expression as` |
| `cca923557d025988` | public-icon-export-star | `FsusBlog/src/frontend/src/components/public/pages/PublicFilterPageContent.vue:69` | 3234 | 1 | public/filter-search | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Back` |
| `b7e8ad9ee46be639` | public-icon-export-star | `FsusBlog/src/frontend/src/components/public/pages/PublicFilterPageContent.vue:84` | 4178 | 1 | public/filter-search | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Back` |
| `362c3a8963a3efa9` | public-icon-export-star | `FsusBlog/src/frontend/src/components/account/AccountHeaderMenu.vue:22` | 653 | 7 | identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#ArrowDown` |
| `8dcb67baa0c607a6` | public-prop-component-default | `FsusUI/vue/packages/components/dropdown/src/dropdown-item-impl.vue:23` | 603 | 7 | identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[control-legality] /workspace/FsusUI/vue/packages/components/dropdown/src/dropdown-item-impl.vue: unresolved component expression icon` |
| `e4f0fb364bcec9bc` | public-prop-component-default | `FsusUI/vue/packages/components/scrollbar/src/scrollbar.vue:10` | 205 | 7 | identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[control-legality] /workspace/FsusUI/vue/packages/components/scrollbar/src/scrollbar.vue: unresolved component expression tag` |
| `0e8ec06f71a03361` | router-view-slot | `FsusBlog/src/frontend/src/layouts/AccountRouteFrame.vue:58` | 1812 | 7 | identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[control-legality] /workspace/FsusBlog/src/frontend/src/layouts/AccountRouteFrame.vue: unresolved component expression Component` |
| `a3bd2ad63cbf5ba6` | public-icon-export-star | `FsusBlog/src/frontend/src/layouts/AccountFrameMobileAction.vue:13` | 416 | 7 | identity/identity-settings, identity/inbox-takeover, admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Expand` |
| `f6e0f9732a1a4105` | route-use-sink | `FsusBlog/src/frontend/src/views/user/IdentityCenter.vue:862` | 34421 | 1 | identity/identity-settings | `route-name-visual-branch` |
| `938a0e93dbe4e389` | route-use-sink | `FsusBlog/src/frontend/src/views/user/IdentityCenter.vue:862` | 34447 | 1 | identity/identity-settings | `route-name-visual-branch` |
| `81bdddbb483a73da` | finite-component-variants | `FsusUI/vue/packages/components/checkbox/src/checkbox.vue:2` | 13 | 2 | identity/identity-settings, admin/form | `[composition-source] ambiguous dynamic component /workspace/FsusUI/vue/packages/components/checkbox/src/checkbox.vue:13` |
| `74acf6392fb9c073` | vite-icons-alias | `FsusUI/vue/packages/components/tag/src/tag.vue:11` | 273 | 5 | identity/identity-settings, identity/inbox-takeover, admin/collection, admin/form, admin/console | `[composition-source] unresolved module /workspace/FsusUI/vue/packages/icons-vue` |
| `9b23ee648451ee30` | vite-icons-alias | `FsusUI/vue/packages/components/tag/src/tag.vue:23` | 634 | 5 | identity/identity-settings, identity/inbox-takeover, admin/collection, admin/form, admin/console | `[composition-source] unresolved module /workspace/FsusUI/vue/packages/icons-vue` |
| `fb9b91389c258443` | public-icon-export-star | `FsusBlog/src/frontend/src/components/ui/PasskeyRegisterModal.vue:104` | 4826 | 1 | identity/identity-settings | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Check` |
| `de876c2a02e98008` | route-use-sink | `FsusBlog/src/frontend/src/views/user/Messages.vue:160` | 6687 | 1 | identity/inbox-takeover | `route-name-visual-branch` |
| `c86a4595e667f700` | default-ts-tsx-render | `FsusUI/vue/packages/components/form/src/form-item.vue:8` | 172 | 4 | identity/inbox-takeover, admin/collection, admin/form, admin/settings | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/components/form/src/form-label-wrap.tsx#default` |
| `46cc44e11059b55f` | finite-component-variants | `FsusUI/vue/packages/components/form/src/form-item.vue:12` | 307 | 4 | identity/inbox-takeover, admin/collection, admin/form, admin/settings | `[composition-source] ambiguous dynamic component /workspace/FsusUI/vue/packages/components/form/src/form-item.vue:307` |
| `ca0e259df29c526f` | public-prop-component-default | `FsusUI/vue/packages/components/select/src/select.vue:228` | 8694 | 4 | identity/inbox-takeover, admin/collection, admin/form, admin/settings | `[control-legality] /workspace/FsusUI/vue/packages/components/select/src/select.vue: unresolved component expression iconComponent` |
| `396c5f520888e295` | public-prop-component-default | `FsusUI/vue/packages/components/select/src/select.vue:235` | 8963 | 4 | identity/inbox-takeover, admin/collection, admin/form, admin/settings | `[control-legality] /workspace/FsusUI/vue/packages/components/select/src/select.vue: unresolved component expression clearIcon` |
| `ad3898a4e626d59a` | default-ts-tsx-render | `FsusUI/vue/packages/components/select/src/select.vue:259` | 9761 | 4 | identity/inbox-takeover, admin/collection, admin/form, admin/settings | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/components/select/src/options.ts#default` |
| `05ced27a3e9eb436` | route-use-sink | `FsusBlog/src/frontend/src/layouts/AdminWorkspaceFrame.vue:40` | 1464 | 5 | admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `route-name-visual-branch` |
| `fdae56732ccd3410` | route-use-sink | `FsusBlog/src/frontend/src/layouts/AdminWorkspaceFrame.vue:40` | 1490 | 5 | admin/dashboard, admin/collection, admin/form, admin/settings, admin/console | `route-name-visual-branch` |
| `c232309ac7f261fa` | public-icon-export-star | `FsusBlog/src/frontend/src/components/admin/users/UserManageHeader.vue:46` | 1386 | 1 | admin/collection | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Search` |
| `adb1c54d40cf9ab2` | public-prop-component-default | `FsusUI/vue/packages/components/avatar/src/avatar.vue:12` | 267 | 1 | admin/collection | `[control-legality] /workspace/FsusUI/vue/packages/components/avatar/src/avatar.vue: unresolved component expression icon` |
| `8da4e25cc96abb2a` | default-ts-tsx-render | `FsusBlog/src/frontend/src/components/admin/users/UserManageTable.vue:110` | 5067 | 1 | admin/collection | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/components/table-v2/src/components/auto-resizer.tsx#default` |
| `34127542ac4642db` | default-ts-tsx-render | `FsusBlog/src/frontend/src/components/admin/users/UserManageTable.vue:112` | 5175 | 1 | admin/collection | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/components/table-v2/src/table-v2.tsx#default` |
| `547a9c0b3698e583` | default-ts-tsx-render | `FsusBlog/src/frontend/src/views/admin/UserManage.vue:80` | 2853 | 1 | admin/collection | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/components/pagination/src/pagination.ts#default` |
| `542869062869ccda` | public-icon-export-star | `FsusBlog/src/frontend/src/components/admin/article/ArticleWriteOutlineRail.vue:14` | 378 | 1 | admin/form | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#List` |
| `147d75d2c902e6a8` | finite-component-variants | `FsusBlog/src/frontend/src/components/admin/article/ArticleWriteOutlineRail.vue:19` | 498 | 1 | admin/form | `[composition-source] ambiguous dynamic component /workspace/FsusBlog/src/frontend/src/components/admin/article/ArticleWriteOutlineRail.vue:498` |
| `8ae2e05eea6e1a3e` | markdown-provider-property | `FsusBlog/src/frontend/src/components/ui/MarkdownEditorAdapter.vue:10` | 277 | 2 | admin/form, admin/settings | `[control-legality] /workspace/FsusBlog/src/frontend/src/components/ui/MarkdownEditorAdapter.vue: unresolved component expression provider.editorComponent` |
| `f97ad10e05a733f8` | default-ts-tsx-render | `FsusBlog/src/frontend/src/components/admin/article/ArticleWriteSidebar.vue:45` | 1757 | 1 | admin/form | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/components/date-picker/src/date-picker.tsx#default` |
| `49589723bab7364d` | public-prop-component-default | `FsusUI/vue/packages/components/switch/src/switch.vue:25` | 663 | 2 | admin/form, admin/settings | `[control-legality] /workspace/FsusUI/vue/packages/components/switch/src/switch.vue: unresolved component expression inactiveIcon` |
| `24a86cfa4d2f6c6d` | public-prop-component-default | `FsusUI/vue/packages/components/switch/src/switch.vue:35` | 1063 | 2 | admin/form, admin/settings | `[control-legality] /workspace/FsusUI/vue/packages/components/switch/src/switch.vue: unresolved component expression activeIcon` |
| `2ad7a5621f457997` | public-prop-component-default | `FsusUI/vue/packages/components/switch/src/switch.vue:49` | 1591 | 2 | admin/form, admin/settings | `[control-legality] /workspace/FsusUI/vue/packages/components/switch/src/switch.vue: unresolved component expression activeActionIcon` |
| `1d3047d9dcaf0e3d` | public-prop-component-default | `FsusUI/vue/packages/components/switch/src/switch.vue:52` | 1718 | 2 | admin/form, admin/settings | `[control-legality] /workspace/FsusUI/vue/packages/components/switch/src/switch.vue: unresolved component expression inactiveActionIcon` |
| `af11a3f72326e6b1` | public-prop-component-default | `FsusUI/vue/packages/components/switch/src/switch.vue:61` | 1945 | 2 | admin/form, admin/settings | `[control-legality] /workspace/FsusUI/vue/packages/components/switch/src/switch.vue: unresolved component expression activeIcon` |
| `fb3acb1d2672c782` | public-icon-export-star | `FsusBlog/src/frontend/src/components/admin/article/ArticleSeoPreviewPanel.vue:54` | 2151 | 1 | admin/form | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Picture` |
| `b3d5c22ad2d88d5d` | default-ts-tsx-render | `FsusUI/vue/packages/components/slider/src/slider.vue:65` | 1951 | 2 | admin/form, admin/settings | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/components/slider/src/marker.ts#default` |
| `425a89ae5ad36eb2` | registry-selected-icon | `FsusBlog/src/frontend/src/components/admin/article/ArticleWriteInspectorRail.vue:21` | 796 | 1 | admin/form | `[control-legality] /workspace/FsusBlog/src/frontend/src/components/admin/article/ArticleWriteInspectorRail.vue: unresolved component expression view.icon` |
| `c34df1a77601c8d2` | public-icon-export-star | `FsusBlog/src/frontend/src/components/admin/article/ArticleWriteInspectorShell.vue:26` | 897 | 1 | admin/form | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Checked` |
| `8833beca61597f91` | finite-component-variants | `FsusBlog/src/frontend/src/components/admin/article/ArticleWriteInspectorShell.vue:30` | 958 | 1 | admin/form | `[composition-source] ambiguous dynamic component /workspace/FsusBlog/src/frontend/src/components/admin/article/ArticleWriteInspectorShell.vue:958` |
| `1679b186eb10740a` | public-icon-export-star | `FsusBlog/src/frontend/src/components/admin/article/ArticleWriteInspectorShell.vue:58` | 2003 | 1 | admin/form | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Close` |
| `b7afa60ded41952a` | public-icon-export-star | `FsusBlog/src/frontend/src/views/admin/Settings.vue:39` | 1722 | 1 | admin/settings | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Warning` |
| `19715bf90b58413f` | default-ts-tsx-render | `FsusBlog/src/frontend/src/views/admin/Settings.vue:51` | 2163 | 1 | admin/settings | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/components/tabs/src/tabs.tsx#default` |
| `de0f4072308fe238` | public-icon-export-star | `FsusBlog/src/frontend/src/views/admin/Settings.vue:175` | 9203 | 1 | admin/settings | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Plus` |
| `6c65257b3b5595ec` | vite-icons-alias | `FsusUI/vue/packages/components/upload/src/upload-list.vue:35` | 1093 | 1 | admin/settings | `[composition-source] unresolved module /workspace/FsusUI/vue/packages/icons-vue` |
| `8fd581c5c469c059` | vite-icons-alias | `FsusUI/vue/packages/components/upload/src/upload-list.vue:98` | 3320 | 1 | admin/settings | `[composition-source] unresolved module /workspace/FsusUI/vue/packages/icons-vue` |
| `43442fb3be31276a` | vite-icons-alias | `FsusUI/vue/packages/components/upload/src/upload-list.vue:108` | 3691 | 1 | admin/settings | `[composition-source] unresolved module /workspace/FsusUI/vue/packages/icons-vue` |
| `718977893df87199` | vite-icons-alias | `FsusUI/vue/packages/components/upload/src/upload-list.vue:119` | 3996 | 1 | admin/settings | `[composition-source] unresolved module /workspace/FsusUI/vue/packages/icons-vue` |
| `b64b3f7b8388f298` | vite-icons-alias | `FsusUI/vue/packages/components/upload/src/upload-list.vue:145` | 4936 | 1 | admin/settings | `[composition-source] unresolved module /workspace/FsusUI/vue/packages/icons-vue` |
| `705498e4eb5193b1` | public-icon-export-star | `FsusBlog/src/frontend/src/components/admin/settings/BrandAssetUploadField.vue:42` | 2002 | 1 | admin/settings | `[composition-source] unknown component export /workspace/FsusUI/vue/packages/element-plus/icons-vue.ts#Plus` |
| `ebd9db001d699a20` | route-use-sink | `FsusBlog/src/frontend/src/components/admin/AdminSystemTabs.vue:39` | 933 | 1 | admin/console | `route-name-visual-branch` |
| `9a7800690dd0102e` | finite-component-variants | `FsusBlog/src/frontend/src/components/admin/AdminStatusMatrix.vue:14` | 338 | 1 | admin/console | `[composition-source] ambiguous dynamic component /workspace/FsusBlog/src/frontend/src/components/admin/AdminStatusMatrix.vue:338` |

## Exact Settings 42-location cross-reference

| Finding | File and line | Group |
|---|---|---|
| `bc188edc3b52bb03` | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:66` | public-icon-export-star |
| `1c1d5fd7fe9c56a1` | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:78` | finite-component-variants |
| `a072f859bcdf0c27` | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:117` | public-icon-export-star |
| `41f3cc7021d25474` | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:122` | public-icon-export-star |
| `ea611549d326956a` | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:145` | public-icon-export-star |
| `7652fb9a89c85a14` | `FsusBlog/src/frontend/src/components/ui/LocaleSelector.vue:169` | public-icon-export-star |
| `362c3a8963a3efa9` | `FsusBlog/src/frontend/src/components/account/AccountHeaderMenu.vue:22` | public-icon-export-star |
| `a3fc9c4cc25ec288` | `FsusUI/vue/packages/components/button/src/button.vue:2` | public-prop-component-default |
| `9cbbaabd703bc345` | `FsusUI/vue/packages/components/button/src/button.vue:30` | public-prop-component-default |
| `510a46f8501931d4` | `FsusUI/vue/packages/components/button/src/button.vue:34` | public-prop-component-default |
| `8dcb67baa0c607a6` | `FsusUI/vue/packages/components/dropdown/src/dropdown-item-impl.vue:23` | public-prop-component-default |
| `e4f0fb364bcec9bc` | `FsusUI/vue/packages/components/scrollbar/src/scrollbar.vue:10` | public-prop-component-default |
| `5d59244be6c33b0e` | `FsusUI/vue/packages/components/dialog/src/dialog-content.vue:17` | public-prop-component-default |
| `05ced27a3e9eb436` | `FsusBlog/src/frontend/src/layouts/AdminWorkspaceFrame.vue:40` | route-use-sink |
| `fdae56732ccd3410` | `FsusBlog/src/frontend/src/layouts/AdminWorkspaceFrame.vue:40` | route-use-sink |
| `0e8ec06f71a03361` | `FsusBlog/src/frontend/src/layouts/AccountRouteFrame.vue:58` | router-view-slot |
| `a3bd2ad63cbf5ba6` | `FsusBlog/src/frontend/src/layouts/AccountFrameMobileAction.vue:13` | public-icon-export-star |
| `b7afa60ded41952a` | `FsusBlog/src/frontend/src/views/admin/Settings.vue:39` | public-icon-export-star |
| `19715bf90b58413f` | `FsusBlog/src/frontend/src/views/admin/Settings.vue:51` | default-ts-tsx-render |
| `d1b43b67a3c93657` | `FsusUI/vue/packages/components/input/src/input.vue:22` | public-prop-component-default |
| `74b10f6311e45c5b` | `FsusUI/vue/packages/components/input/src/input.vue:59` | public-prop-component-default |
| `ba6651d688b512aa` | `FsusUI/vue/packages/components/input/src/input.vue:74` | finite-component-variants |
| `c00c0161756c7504` | `FsusUI/vue/packages/components/input/src/input.vue:87` | public-prop-component-default |
| `c86a4595e667f700` | `FsusUI/vue/packages/components/form/src/form-item.vue:8` | default-ts-tsx-render |
| `46cc44e11059b55f` | `FsusUI/vue/packages/components/form/src/form-item.vue:12` | finite-component-variants |
| `de0f4072308fe238` | `FsusBlog/src/frontend/src/views/admin/Settings.vue:175` | public-icon-export-star |
| `6c65257b3b5595ec` | `FsusUI/vue/packages/components/upload/src/upload-list.vue:35` | vite-icons-alias |
| `8fd581c5c469c059` | `FsusUI/vue/packages/components/upload/src/upload-list.vue:98` | vite-icons-alias |
| `43442fb3be31276a` | `FsusUI/vue/packages/components/upload/src/upload-list.vue:108` | vite-icons-alias |
| `718977893df87199` | `FsusUI/vue/packages/components/upload/src/upload-list.vue:119` | vite-icons-alias |
| `b64b3f7b8388f298` | `FsusUI/vue/packages/components/upload/src/upload-list.vue:145` | vite-icons-alias |
| `705498e4eb5193b1` | `FsusBlog/src/frontend/src/components/admin/settings/BrandAssetUploadField.vue:42` | public-icon-export-star |
| `49589723bab7364d` | `FsusUI/vue/packages/components/switch/src/switch.vue:25` | public-prop-component-default |
| `24a86cfa4d2f6c6d` | `FsusUI/vue/packages/components/switch/src/switch.vue:35` | public-prop-component-default |
| `2ad7a5621f457997` | `FsusUI/vue/packages/components/switch/src/switch.vue:49` | public-prop-component-default |
| `1d3047d9dcaf0e3d` | `FsusUI/vue/packages/components/switch/src/switch.vue:52` | public-prop-component-default |
| `af11a3f72326e6b1` | `FsusUI/vue/packages/components/switch/src/switch.vue:61` | public-prop-component-default |
| `ca0e259df29c526f` | `FsusUI/vue/packages/components/select/src/select.vue:228` | public-prop-component-default |
| `396c5f520888e295` | `FsusUI/vue/packages/components/select/src/select.vue:235` | public-prop-component-default |
| `ad3898a4e626d59a` | `FsusUI/vue/packages/components/select/src/select.vue:259` | default-ts-tsx-render |
| `b3d5c22ad2d88d5d` | `FsusUI/vue/packages/components/slider/src/slider.vue:65` | default-ts-tsx-render |
| `8ae2e05eea6e1a3e` | `FsusBlog/src/frontend/src/components/ui/MarkdownEditorAdapter.vue:10` | markdown-provider-property |

## Executed public API examples

The actual supplied `createCompositionSource` and canonical resolver execute these results (no substitute parser):

- `resolveTag(Settings.vue, Warning)` returns the accepted local public-barrel source; `componentFile` throws unknown component export icons-vue.ts#Warning.
- Explicit `publicIdentity(@ozwasyd/element-plus/icons-vue, Warning)` reaches `icons-vue/dist/types/components/warning.vue.d.ts#_default`. This type identity is not runtime source. The actual `createFsusUiAliases` edge maps internal @element-plus/icons-vue to `icons-vue/src/index.ts`.
- `resolveTag(Settings.vue, el-tabs)` returns the real public ElTabs identity; `componentFile` fails at tabs.tsx#default.
- `resolveExpression(LocaleSelector.vue, item.href ? a : button)` with string-literal a/button returns two native targets; composition helper rejects the finite alternatives.
- `resolveExpression(MarkdownEditorAdapter.vue, provider.editorComponent)` throws; the actual local MarkdownTextEditor import resolves. The provider uses one guarded object and returns that object.

Required next action: canonical #1894 reviews/applies the bounded preparation proposal and the analyzer-owned repairs; canonical #1895 supplies runtime export/module and state/prop/slot/provider dataflow capabilities as needed. Return exact commits and current executable evidence. Do not disable unknown-state/public-surface refusals or edit Settings/other product owners.

This handoff adds no new matrix, source resolver, runtime runner, receipt schema, acceptance record or production exception. GitHub content API writes remain paused.
