# Article Canvas link generated-route source WIP

Ordinary source progress only: no grant, lease, receipt, authority, qualification
or end-to-end acceptance is created by this record.

## Exact identity and bounded source change

- Original integrated Blog baseline #4327:
  `4f7954ebcad5d333dfa0c4d330be38bdcaed3518`.
- This independent branch starts from the separately source-accepted #4329 head:
  `576688afe22d6fa8ae45bb9ab63236f68915932d`.
- Source checkpoint: `098459426c170b2f40a56d9bd4470c534609b78c`.
- Branch: `codex/article-canvas-link-generated-routes-20261014`.
- Source diff: only `src/frontend/src/api/articleCanvasLinks.ts`, 5 additions /
  4 deletions. No original batch is imported or overlaid.
- Source blob: `3cbf2c14fc631ec3ec818175bbea84a31ae537d7`.
- Source SHA-256: `3cc4377d642ad5de50a91817e24fe113d932117fa49b89f60bf51f181886ca51`.
- Real clean local UI957: `903db034a14254fb162f51b9c25d3703ea20ccb5`,
  `/workspace/FsusUI`; both public aliases statically resolve to actual
  `vue/packages/element-plus/index.ts`. No replacement types or mocked package.
- Separate documentation commit adds this WIP and explicitly limits the prior
  Canvas cursor-equivalence claim in `authoring-canvas-generated-route-source.md`.
  No #4329 product source changes. The draft PR records its exact later head.

## Why there are two real migration items

`articleCanvasLinksApi.convert` and `history` still assembled `articlePath` and
`/history`. Both existing descriptors are present and byte-identical between
#4327 and #4329:

| Caller | Existing descriptor | Route |
| --- | --- | --- |
| convert | binary_author_article_canvas_link_apply | /api/binary/author/articles/{articleId:int}/canvas-links |
| history | binary_author_article_canvas_link_history | /api/binary/author/articles/{articleId:int}/canvas-links/history |

The original endpoints are in `AuthoringEndpoints.ArticleCanvasLinkRoutes.cs`.
POST reads ArticleCanvasLinkRequest, checks its source ID against the route ID,
derives owner from the required authenticated admin principal/primary-site, calls
IArticleCanvasLinkWriter.ConvertAsync, requires ArticleWrite and PoW, and emits
ArticleCanvasLinkReceipt. GET uses that same writer/owner and ArticleWrite to
return ArticleCanvasLinkHistoryResponse. RuntimeDomainServiceCollectionExtensions
binds the writer to the existing scoped ArticleService; there is no missing new
owner/schema/descriptor required for this URL-only refactor. This is source
tracing, not proof of an active session or successful Server execution.

The real UI view creates createArticleCanvasLinkTransaction from the actual
Canvas session owner and session abort signal. The workspace invokes that provider.
Its commit/undo/redo build the typed wire input with `article(...)`; history also
calls `article(...)` before its API request. `article` canonicalizes its admitted
number|string input through the existing positive/safe-integer/int32 bound and
returns a number. The wire request's sourceArticleId is number. At the API entry,
the original guard admits only integer numbers 1..2147483647. The helper now named
`articleParams` preserves the guard's complete source and the synchronous
RangeError `article_canvas_link_article_id_invalid`, including its timing before
transport and mutation encoding. Rejected invalid input values still reach that
same guard first. No query/cursor is involved in these two routes. Accepted
positive int32 numbers stringify as decimal digits and URI encoding leaves those
digits unchanged. Public parameters, return types and caller source are untouched.

## Preserved transport, bytes, readers and errors

The API still supplies a prebuilt string through `binaryUrl`, not `binaryRoute`.
`requestBinaryOnly` generic result, privateScope admin, frameType, signal and
complete requestOptions method/PoW/body syntax are unchanged under compiler AST
comparison. Mutation still encodes the same frame with the same wire encoder.
The typed decoderRegistry already maps both response frames to their existing
ArticleCanvasLink decoders. None of those files or functions is replaced.

The actual source has an existing provider lease around operation/receipt work
and the existing transport lease around request work. This batch adds no lease
wrapper/acquisition and changes neither lifetime. Caller abort forwarding,
generation assertions, release/finally, pending-write uncertainty, receipt checks,
transport errors and failure policy remain their original owners. Keeping
binaryUrl also preserves its existing binary_legacy_request identity, legacy
route class and retry/credential resolution; no descriptor-driven transport
policy is silently enabled. This is not a whole-transport/decoder migration.
Source identity supports byte/reader/error preservation; no request bytes,
reader execution, PoW, actual lease or response was sampled/executed.

## Prior Canvas cursor claim correction

The #4329 source acceptance is limited to valid typed cursors (string order/id,
or a null whole cursor). An invalid JavaScript cursor with a null/undefined field
was stringified by the old URLSearchParams.set as "null"/"undefined"; the generated
helper now omits that field. Arbitrary-JavaScript equivalence is not claimed.
That difference is now explicitly disclosed in the original ordinary WIP as well.
No accepted authoringCanvas.ts source is changed to alter that behavior.

## Fresh original static checks

These original entry points ran at exact #4329 base and this final source:

```sh
FSUSBLOG_USE_LOCAL_FSUSUI=1 FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application
FSUSBLOG_USE_LOCAL_FSUSUI=1 FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node tools/frontend/check-frontend-style.mjs --mode strict-full --file src/frontend/src/api/articleCanvasLinks.ts
node tools/docs/check-authoritative-development-docs.mjs
node tools/governance/check-code-intent.mjs
```

- Complete application: exit2/FAIL before and after, 29 diagnostics (Blog4/UI25).
  Full output, messages, multiplicity and locations are byte-identical; added0 /
  removed0. Original complete config, strict/unused/erasableSyntaxOnly rules and
  real aliases are unchanged. No narrower program, skipped source, noCheck,
  alternate compiler, stubs or suppressions. TypeScript6.0.3/vue-tsc3.2.7.
- Original selected-file strict-full lint: exit0 before and after, each
  `files=1 eslint=1 stylelint=0 violations=0 new=0`. Original locked ESLint10.8.0
  and Stylelint are available. This TS-only batch has no eligible CSS source;
  no whole-project style acceptance is claimed. No rule/config/lock/ignore edit.
- Compiler AST inspection: exit0, source parse0, original int32 guard/public
  signatures/generic result and complete non-URL options unchanged, two correct
  original descriptors, no added lease, reserved source byte-identical, complete
  generated config identical, real clean UI957 alias binding. Source was read
  by the compiler only; no product/transport/helper/decoder import/evaluation.
- Original authoritative docs: exit1 with 41 original findings before/after.
  Original code intent: exit1 with 2 original findings before/after. Complete
  outputs byte-identical. Their complete raw diagnostics are preserved in the
  [prior WIP](authoring-canvas-generated-route-source.md), including the original
  spatial-index and C++ intent failures; no waiver/green classification.
- Diff check and source commit metadata pass. Final two-commit range and actual
  REST PR metadata checks are recorded at delivery. Remote checks are never
  inferred from local results or absence.

Byte-identical base/final log digests:

- base-full-typecheck.log: `0a2d72653ea644e2090522ba1f5b6c39fc4a85a3a88e998aa6f4f4fc49f50930`.
- base-docs.log: `7ef7c37f2d494d72fcc2ae562ad45efee5044fa9ff83037812499955ee214403`.
- base-intent.log: `9bd233812fe41eec87b497718f0d941f36be2e593794158fbf2b03ecb5488cac`.

Original generated full config SHA-256:
`f5a2e3ec68b9476fc78167580cc8b9a4f7c89a9de7d42ad840ff0a73840e3e05`.

## Complete original compiler failures (base = final)

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

## Unfinished boundaries, delivery and rollback

Only these two URL constructions are newly migrated. #4329's 11 Canvas route calls
are preserved, with their typed-cursor limitation above. Transport metadata,
readers, decoderRegistry, Server/CAS/transaction/security behavior and every
native/UX/render/runtime/frozen qualification remain unverified here.
`api/authoringCanvas.ts`, `services/authoringCanvasPackage.ts`, the provider,
transport, decoderRegistry, generated/frozen routes/codecs, endpoint/writer,
configuration, policies, locks, fixtures, catalog and authority/receipt outputs
remain byte-identical to the accepted base. Both worktrees remain free of
unrelated tracked changes.

All runtime/product/helper execution, tests/collection/list/discovery,
browser/render/native/frozen producer execution and qualification remain
HOLD/UNRUN. No fabricated grant/lease/receipt, merge/Ready/issue close, release,
package publication or workflow run/rerun. The normal push/draft metadata flow
does not establish any remote qualification. Physical/runtime alias remains
UNVERIFIED despite the actual clean source/static realpath binding.

Deliver as an independent draft against the unchanged exact #4329 branch.
Pending: independent exact-source review, the original 29 compiler and 41/2
governance failures, all actual authority/PoW/request/response/lease/native/UI
acceptance. Rollback only source checkpoint
`098459426c170b2f40a56d9bd4470c534609b78c` if route-source review finds an
equivalence defect; preserve #4327 and accepted #4329 source and the cursor
limitation disclosure. No public contract, schema or normative API doc change.
