# Authoring Canvas generated-route source WIP

Ordinary source progress record only. This is not a grant, lease, authority,
fixture, catalog, qualification or receipt. No end-to-end completion is claimed.

## Exact source identity and scope

- Fixed Blog integration base: #4327 `4f7954ebcad5d333dfa0c4d330be38bdcaed3518`.
- Source checkpoint: `93beabbd31da6095f1064d973dd5aa91ad21657e`.
- Branch: `codex/authoring-canvas-generated-routes-20261014`.
- The source checkpoint changes only `src/frontend/src/api/authoringCanvas.ts`.
  This separate WIP commit adds only this ordinary record. Existing composition,
  feature source and old records are preserved; no old batch is re-imported.
- Source Git blob: `71115a6122f6f46bd4987fc35031f27f51f79516`.
- Source SHA-256: `6f7f657ea91d7a6f5773bf5a94beec814b55c05c9891065f1a6ebd37fa19ae8d`.
- Real clean UI957: `903db034a14254fb162f51b9c25d3703ea20ccb5`,
  `/workspace/FsusUI`. Both public aliases resolve to its real
  `vue/packages/element-plus/index.ts`; no mock or substitute declarations.
- Initial restored Blog checkout was `29051db2a80db7770dfe78a1db6e4c6998337324`;
  the requested base was fetched and checked out before implementation.
  Initial restored UI was `8db0ac8f49749e3e5f28be5051bb3d3ed71ada71`;
  exact UI957 was fetched and selected before either full application check.
  Both initial worktrees were clean. No implementation from those older heads
  was overlaid onto the fixed base.
- Read Blog/UI AGENTS, current API/AEDS, source ownership, architecture,
  coding, document lifecycle and change-contract boundaries. This nonvisual
  API refactor does not change UI/design or React code and needs no design
  production or rendered acceptance skill. All checks are static/compiler work.

## Actually migrated

All eleven URL arguments now call the existing `buildFsusBinaryRoute` with
existing descriptors. Removed the local ROOT literal and suffix concatenation.
Path interpolation/URI encoding and query serialization belong to that helper.
The local pagination function now supplies data only: limit then cursorOrder
then cursorId. Limits remain list100/nodes256/edges256; absent cursors omit both
query fields through the existing null/undefined omission rule. Typed cursor
values remain strings and are serialized by the same URLSearchParams semantics.

Equivalence is limited to valid typed cursors: `AuthoringCanvasPageCursor`
requires string `order` and `id`, or the whole cursor is null. Arbitrary JavaScript
objects are not covered. For an invalid cursor with a null/undefined field, the
old `URLSearchParams.set` stringified that field as `"null"`/`"undefined"`, whereas
the existing generated helper omits it. This is a real out-of-contract behavioral
difference, not arbitrary-JavaScript equivalence or a new validation guarantee.
The limited source acceptance of #4329 does not establish runtime qualification.

| API method | Existing operation ID |
| --- | --- |
| list | binary_author_canvas_list |
| header | binary_author_canvas_header |
| nodes | binary_author_canvas_nodes |
| edges | binary_author_canvas_edges |
| history | binary_author_canvas_history |
| create | binary_author_canvas_create |
| apply | binary_author_canvas_apply |
| prepare | binary_author_canvas_prepare |
| undoRedo | binary_author_canvas_history_apply |
| delete | binary_author_canvas_delete |
| resolve | binary_author_canvas_resolve |

The helper does not validate GUIDs or obtain a private lease. `canvasParams`
retains the original case-insensitive GUID grammar, empty-GUID refusal and
`canvas_id_invalid` error before requesting or encoding mutation payloads.
`read<T>` is byte-identical to the fixed base. Every public method parameter,
frame, typed reader, signal and mutation method/frame/payload expression is
unchanged under compiler AST inspection. The single existing admin
`runPrivateRequest` still supplies the real lease signal, asserts generation,
and releases in finally. `binaryRequest`, AEDS encoding/decoding, PoW=true for
mutations, cancellation check and protocol-failure mapping remain unchanged.
This establishes source preservation, not sampled network/request bytes or
executed lease/PoW behavior. No product helper/module was imported or executed.

## Still not migrated or qualified

- The API continues to choose methods, frame types, auth scope, mutation PoW and
  typed readers locally. Descriptor security/frame metadata does not drive a
  newly migrated transport here. No whole transport or decoderRegistry migration.
- `src/frontend/src/api/articleCanvasLinks.ts` still has `articlePath` and manual
  history suffix construction for #3738; it is outside this single-file batch.
- `services/authoringCanvasPackage.ts` is reserved to the original Canvas owner
  and is byte-identical to the fixed base; it was not edited or committed here.
- Generated descriptors, codecs, frozen routes, fixtures, catalogs, policies,
  configuration, locks and qualification/authority/receipt outputs are untouched.
  The public API/wire/ABI contract has not expanded. No current normative docs
  change is required for equivalent URL construction; this WIP records the limit.
- #3735/#3736/#3738 are OPEN. Actual Server/CAS/provider/session/PoW/security,
  typed reader execution, race/error/page behavior, native/wire and rendered UI
  acceptance remain unverified. Source helper migration is not end-to-end work.
- All runtime/product/helper evaluation, tests, collection/list/discovery,
  browser/render/native/frozen generation and qualification remain HOLD/UNRUN.
  No test.sh help/fast invocation, grant/lease fabrication, receipt generation,
  release, merge, Ready, issue closure or package publication.
- Physical/runtime local-alias qualification remains UNVERIFIED; static realpath
  and clean exact UI957 source binding are the limited evidence available here.

## Exact static verification

Original complete application command, at the fixed base and final source:

```sh
FSUSBLOG_USE_LOCAL_FSUSUI=1 FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application
```

Both exit2/FAIL: 29 diagnostics (Blog4/UI25). Complete stdout/stderr is byte
identical, including all messages, multiplicity and locations; no normalization
or filtered passing program. Added0/removed0. The intermediate candidate was
also exit2 with the same diagnostics. The final full rerun follows the single
lint semicolon repair. Original generator, full app include/config, strict rules,
erasableSyntaxOnly and unused checks are unchanged; no narrower tsconfig/stub,
noCheck, disabled rules or alternate decoder was introduced.

- Complete compiler log SHA-256, base and final:
  `0a2d72653ea644e2090522ba1f5b6c39fc4a85a3a88e998aa6f4f4fc49f50930`.
- Actual generated full application config SHA-256:
  `f5a2e3ec68b9476fc78167580cc8b9a4f7c89a9de7d42ad840ff0a73840e3e05`.
- Original tsconfig.app.json SHA-256:
  `d8d55a517af2f580fe560d7327bde8124fc284e4e9e08af6a1773cd3775b128d`.
- Compiler/tool versions: TypeScript6.0.3, vue-tsc3.2.7, locked ESLint10.8.0.

Original lint entry point and unchanged complete strict rules:

```sh
FSUSBLOG_USE_LOCAL_FSUSUI=1 FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node tools/frontend/check-frontend-style.mjs --mode strict-full --file src/frontend/src/api/authoringCanvas.ts
```

Base exit0, candidate initially exit1 for the newly added private return type's
missing member semicolon (`11:60 eslint/@stylistic/member-delimiter-style`).
Added that required semicolon only; final exit0:
`files=1 eslint=1 stylelint=0 violations=0 new=0`.
This is original selected-file lint with a full typed application program, not
whole-project style acceptance. There is no CSS-eligible changed source.

The original style toolchain was absent. The first locked npm install failed
because `/home/agent/.npm/_cacache` could not be created; its initial logging
wrapper's final tail status was not accepted as success. Retried the same locked
`npm ci --ignore-scripts` with writable cache `/workspace/.setup/npm-cache`,
exit0 (257 packages). No policy/rule/config/manifest/lock edit or tool replacement.

Compiler-only AST inspection exit0: 11 existing route IDs/path matches; unchanged
public method parameter text and all non-URL read arguments; byte-identical
`read<T>` and original guard; exactly one admin lease wrapper; clean UI957 and
both real aliases; generated descriptor bytes unchanged. This inspection reads
source using the installed TypeScript compiler; no product code is executed.

`git diff --check` and source commit range contract check pass. The two original
governance commands also ran before and after, retaining actual failures:

```sh
node tools/docs/check-authoritative-development-docs.mjs
node tools/governance/check-code-intent.mjs
```

Docs: exit1, 41 original ownership findings, complete output byte identical,
SHA-256 `7ef7c37f2d494d72fcc2ae562ad45efee5044fa9ff83037812499955ee214403`.
Intent: exit1, 2 original findings, complete output byte identical,
SHA-256 `9bd233812fe41eec87b497718f0d941f36be2e593794158fbf2b03ecb5488cac`.
These are unresolved, not waived by WIP. Unrelated source/authority repair is
outside scope. The compiler's four Blog failures are Upload Preview/Facts
operation/frame projection debt and Analytics ref debt; the remaining 25 are
UI957 unused-ref/erasable-syntax debt. No authoringCanvas diagnostic is added.

GitHub Actions permissions read returned403 (integration cannot read permission
settings); rulesets read returned403 (plan/private feature restriction). No remote
PASS, disabled-Actions state or merge eligibility is inferred. No remote workflow
was explicitly requested or rerun.

## Original complete compiler diagnostics (base = final)

```text
[fsusui-typecheck] local root: /workspace/FsusUI
src/api/upload.ts(226,24): error TS2820: Type '"binary_post_upload_uploadId_preview"' is not assignable to type '"binary_delete_admin_article_id_int" | "binary_delete_admin_article_permanent_id_int" | "binary_delete_admin_article_trash" | "binary_delete_admin_security_anti_crawler_allowlist_id" | ... 286 more ... | "binary_put_upload_uploadId_part"'. Did you mean '"binary_post_upload_uploadId_complete"'?
src/api/uploadFacts.ts(20,24): error TS2820: Type '"binary_post_upload_uploadId_facts"' is not assignable to type '"binary_delete_admin_article_id_int" | "binary_delete_admin_article_permanent_id_int" | "binary_delete_admin_article_trash" | "binary_delete_admin_security_anti_crawler_allowlist_id" | ... 286 more ... | "binary_put_upload_uploadId_part"'. Did you mean '"binary_put_upload_uploadId_part"'?
src/api/uploadFacts.ts(21,53): error TS2551: Property 'UploadAssetFacts' does not exist on type '{ readonly Unknown: 0; readonly ArticleList: 1; readonly ArticleDetail: 2; readonly ArticleHot: 3; readonly ArticleSearch: 4; readonly CommentArticleCursor: 5; readonly CommentUserCursor: 6; ... 265 more ...; readonly DocumentExportPageResponse: 281; }'. Did you mean 'UploadStatus'?
src/views/admin/Analytics.vue(99,33): error TS6133: 'regionChartRef' is declared but its value is never read.
../../../FsusUI/vue/packages/components/breadcrumb/src/breadcrumb.vue(25,7): error TS6133: 'breadcrumb' is declared but its value is never read.
../../../FsusUI/vue/packages/components/carousel/src/carousel-item.vue(41,3): error TS6133: 'carouselItemRef' is declared but its value is never read.
../../../FsusUI/vue/packages/components/carousel/src/carousel.vue(96,3): error TS6133: 'root' is declared but its value is never read.
../../../FsusUI/vue/packages/components/date-picker/src/date-picker-com/basic-date-table.vue(64,3): error TS6133: 'tbodyRef' is declared but its value is never read.
../../../FsusUI/vue/packages/components/input/src/input.vue(251,9): error TS6133: 'wrapperRef' is declared but its value is never read.
../../../FsusUI/vue/packages/components/perception-challenge/src/localization-challenge.vue(71,7): error TS6133: 'targetRef' is declared but its value is never read.
../../../FsusUI/vue/packages/components/radio/src/radio-button.vue(50,9): error TS6133: 'radioRef' is declared but its value is never read.
../../../FsusUI/vue/packages/components/radio/src/radio.vue(56,9): error TS6133: 'radioRef' is declared but its value is never read.
../../../FsusUI/vue/packages/components/responsive-collection/src/responsive-collection.vue(129,7): error TS6133: 'getItemKey' is declared but its value is never read.
../../../FsusUI/vue/packages/components/slider/src/button.vue(65,3): error TS6133: 'button' is declared but its value is never read.
../../../FsusUI/vue/packages/components/slider/src/button.vue(66,3): error TS6133: 'tooltip' is declared but its value is never read.
../../../FsusUI/vue/packages/components/slider/src/slider.vue(131,3): error TS6133: 'slider' is declared but its value is never read.
../../../FsusUI/vue/packages/components/slider/src/slider.vue(132,3): error TS6133: 'firstButton' is declared but its value is never read.
../../../FsusUI/vue/packages/components/slider/src/slider.vue(133,3): error TS6133: 'secondButton' is declared but its value is never read.
../../../FsusUI/vue/packages/components/slider/src/slider.vue(242,7): error TS6133: 'sliderWrapper' is declared but its value is never read.
../../../FsusUI/vue/packages/components/switch/src/switch.vue(147,7): error TS6133: 'core' is declared but its value is never read.
../../../FsusUI/vue/packages/components/table-v2/src/constants.ts(1,13): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
../../../FsusUI/vue/packages/components/table-v2/src/constants.ts(6,13): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
../../../FsusUI/vue/packages/components/table-v2/src/constants.ts(11,13): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
../../../FsusUI/vue/packages/components/tooltip-v2/src/arrow.vue(22,7): error TS6133: 'arrowRef' is declared but its value is never read.
../../../FsusUI/vue/packages/components/tooltip-v2/src/common.ts(14,13): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
../../../FsusUI/vue/packages/components/tooltip-v2/src/content.vue(42,23): error TS6133: 'contentRef' is declared but its value is never read.
../../../FsusUI/vue/packages/components/tree-v2/src/virtual-tree.ts(29,13): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
../../../FsusUI/vue/packages/components/tree-v2/src/virtual-tree.ts(36,19): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
../../../FsusUI/vue/packages/utils/vue/vnode.ts(22,13): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.
```

## Original complete document diagnostics (unchanged)

```text
[authoritative-development-docs] tools/contracts/author-article-selection-wire-templates/wire.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/author-article-selection-wire-templates/wire.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/author-article-selection-wire-templates/wire.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/document-export-wire-templates/wire.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/document-export-wire-templates/wire.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshot.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshot.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshot.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotGroup.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotGroup.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotGroup.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotIdentity.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotIdentity.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotIdentity.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotLayout.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotLayout.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotLayout.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotRequest.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotRequest.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotRequest.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotResponse.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotResponse.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotResponse.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotScope.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotScope.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotScope.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotShell.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotShell.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotShell.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTab.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTab.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTab.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTransportReceipt.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTransportReceipt.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/AuthoringWorkspaceSnapshotTransportReceipt.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/primitives.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/primitives.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/workspace-snapshot-wire-templates/primitives.ts.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/writing-aid-preference-wire-templates/receipt.cs.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/writing-aid-preference-wire-templates/wire.hpp.inc has no style owner or non-source classification
[authoritative-development-docs] tools/contracts/writing-aid-preference-wire-templates/wire.ts.inc has no style owner or non-source classification
```

## Original complete intent diagnostics (unchanged)

```text
[code-intent] 2 error(s) across 5711 checked file(s):
- src/frontend/src/services/authoringCanvasSpatialIndex.ts:1 unbounded performance claim 'high-performance' must be structural or evidence-registered
- src/frontend/wasm/aeds/include/font_theme_admin_pods.hpp:338 unbounded performance claim 'no allocation' must be structural or evidence-registered
```

## Delivery and rollback

Deliver on the independent branch as a draft PR against the exact #4327 branch.
The source checkpoint SHA above binds the implementation; the later documentation
commit and exact PR head are recorded in PR metadata/readback, avoiding a
self-referential commit claim. No issue is closed. Independent source review,
existing compiler/governance debt and every original runtime/frozen qualification
remain outstanding. Roll back only source checkpoint `93beabbd31da6095f1064d973dd5aa91ad21657e` if route-source
review finds an equivalence defect; preserve all #4327 feature/composition source.
