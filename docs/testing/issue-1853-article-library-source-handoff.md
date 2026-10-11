# ArticleLibraryRail source integration lint handoff

This is a historical source-check handoff for issue1853 and [draft4227](https://github.com/Ozwasyd/FsusBlog/pull/4227). It contains no runtime, test or qualification receipt.

## Exact input and producer

The original `tools/frontend/check-frontend-style.mjs --mode changed --file ...` checked two host SFCs and66 inherited original paths, using real UI source `cb115a49424e60a841a4c6744cea11c9d69e0ffd`, tree `43a11ce35084538fb68d8befa82c2e38be25dc5e`, [source-offer draft932](https://github.com/Ozwasyd/FsusUI/pull/932). Original strict/rule configuration and actual local-alias producer were retained. Initial Blog source `a4b4aaa69773e0039ce1acdb525bb7aef3d8b330` produced89 inherited style findings, owned0. This captured diagnostic record is authored from that real log; it is not a canonical generated authority or a baseline exemption.

[`issue-1853-article-library-source-lint.json`](issue-1853-article-library-source-lint.json) preserves all89 records with exact path, line, column, rule, original message, original source head and Git blob. Every record has current matching state. The original bytes are preserved for owner assignment; source checks never execute those product modules.

## Subsequent state at eb36de79b

Minimal original Router type-export `77cccc8b697edaa77597c8761c3393dc80bb88bd` resolves two derived Write unsafe-argument findings without editing Write. Original journal/storage repair `e788d215448c417c214d2c3399352ea173004159` is consumed byte-for-byte. Current69-file style FAIL95:87 inherited findings plus8 separately checked original Router findings. Exact unchanged Router diagnostics belong to original9d72a1c93/blob15ea0a9653a9bb31f9502af281dc1f7943af84e9, not the type-export lines: consistent-type-imports1:1; require-await141:5,528:5,560:5,1100:9; brace-style287:59; prefer-nullish-coalescing296:44,981:79. The8 Router repairs are separately owned source integration work.

Current focused strict TS FAIL183 errors/294 output lines, owned0/inherited9; nine inherited errors are genuine current-master upload DTO/schema/route gaps. Journal TS1294/private-storage TS2345 and Write status-export TS2459 are resolved. Broader application errors remain. Do not promote this source evidence to runtime or full application PASS.

## Owner assignment

| File | Original source | Count | Exact rule and line:column |
| --- | --- | --- | --- |
| `src/frontend/src/api/upload.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 6 | `eslint/@typescript-eslint/no-unsafe-assignment` @ 185:11, 187:9; `eslint/@typescript-eslint/no-unsafe-member-access` @ 198:16, 198:48, 198:100; `eslint/@typescript-eslint/no-unsafe-argument` @ 198:93 |
| `src/frontend/src/api/uploadFacts.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 4 | `eslint/@typescript-eslint/no-unsafe-assignment` @ 19:11, 21:32; `eslint/@typescript-eslint/no-unsafe-member-access` @ 29:16, 29:48 |
| `src/frontend/src/components/admin/article/ArticleWriteOutlineRail.vue` | `de6df11110b5d060a001fad36bb604627323e32a` | 64 | `eslint/import-x/order` @ 89:1; `eslint/@stylistic/brace-style` @ 127:28, 136:39, 141:80, 142:55, 149:65, 157:97, 163:67, 165:103, 173:32, 192:87, 194:21, 194:58, 200:86, 202:21, 202:28, 276:69, 350:101, 352:72, 353:33, 354:43, 369:10, 375:42, 385:55, 387:9, 389:5, 389:13, 394:43, 396:9, 399:5, 399:13, 404:26, 408:17, 413:35, 416:25, 417:31, 421:98, 429:30, 434:34, 441:58, 442:18, 449:34, 453:46, 460:66, 464:64; `eslint/curly` @ 137:34, 150:26, 159:47, 169:24, 386:40, 395:40, 405:18, 414:30, 435:24, 438:27, 450:26, 455:27, 456:10; `eslint/@typescript-eslint/no-floating-promises` @ 151:13; `eslint/@stylistic/comma-dangle` @ 297:25; `eslint/vue/script-indent` @ 298:1; `stylelint/media-feature-range-notation` @ 671:8; `stylelint/@stylistic/indentation` @ 677:6, 678:2 |
| `src/frontend/src/locales/de-DE/admin.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 1 | `eslint/@stylistic/comma-dangle` @ 10:64 |
| `src/frontend/src/locales/en-US/admin.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 1 | `eslint/@stylistic/comma-dangle` @ 10:50 |
| `src/frontend/src/locales/es-419/admin.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 1 | `eslint/@stylistic/comma-dangle` @ 10:65 |
| `src/frontend/src/locales/fr-FR/admin.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 1 | `eslint/@stylistic/comma-dangle` @ 10:63 |
| `src/frontend/src/locales/ja-JP/admin.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 1 | `eslint/@stylistic/comma-dangle` @ 10:30 |
| `src/frontend/src/locales/ko-KR/admin.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 1 | `eslint/@stylistic/comma-dangle` @ 10:35 |
| `src/frontend/src/locales/pt-BR/admin.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 1 | `eslint/@stylistic/comma-dangle` @ 10:63 |
| `src/frontend/src/locales/ru-RU/admin.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 1 | `eslint/@stylistic/comma-dangle` @ 10:64 |
| `src/frontend/src/locales/zh-CN/admin.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 1 | `eslint/@stylistic/comma-dangle` @ 7:28 |
| `src/frontend/src/locales/zh-Hant/admin.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 1 | `eslint/@stylistic/comma-dangle` @ 10:28 |
| `src/frontend/src/services/authoring/articleAttachmentUploadProvider.ts` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 3 | `eslint/@typescript-eslint/no-unsafe-assignment` @ 84:23; `eslint/@typescript-eslint/no-unsafe-member-access` @ 88:31; `eslint/@typescript-eslint/no-unsafe-argument` @ 92:65 |
| `src/frontend/src/views/admin/article/Write.vue` | `e6bb1b6c803a20da0bb047c96d0e86a5715fc73a` | 2 | `eslint/@typescript-eslint/no-unsafe-argument` @ 1087:9, 1134:72 |


The full JSON carries original messages and blobs omitted from the compact table. Historical matching state has been refreshed against the current snapshot below; the original89 messages and blobs remain intact. Outline and journal-side Writer bytes originally came from de6df111; locale/upload/attachment-provider/Write source came from e6bb. Exact original head is recorded per file, so these findings can be assigned without copying a whole branch or editing another owner's implementation.

## Holds and follow-up

No rules, flags, baselines, fixtures, test entries or generated authorities were relaxed. All product import/install/mount, tests/list/discovery, runtime/browser/security/privacy/receipt/native/qualification lanes remain UNRUN. Production startup/query/layout ports, original second retained binding and actual article-key/reset/unmount continuity remain WIP. This historical diagnostic input is retained even after its real findings are fixed; new source/check results must identify their own exact head and configuration.

## Current exact source snapshot at aeef4e68

Actual Blog source `aeef4e68b8ac1795c6123cbaaa53158232d528d0`, tree `1fabc21c85778d91f55f4d68779b4b4a57206369`, consumes original Layout caller `ecfbbd9727101fcbd9263d761b034ce1900379e1` and actual DTO source `c08ace9061492fbfab1dea8d57928a998938dcc8`. All68 inherited path blobs match their recorded originals. Actual UI source-offer `452c075bd0325a991d07e91a347254fe2ea3ce8f`, tree `a89e393fb62e4568a922b0216f38882a80abec84`, normally merges `cb115a49424e60a841a4c6744cea11c9d69e0ffd` and real public session source `9f92c8734409cef0c1984d4f512cb7477c9a77e4`; no SDK declaration is fabricated.

Current strict focused vue-tsc is FAIL178 errors/289 output lines, owned0/inherited4/broader174. The same application extends/options and original alias producer remain in force. The four inherited errors are `upload.ts:186` route ID `binary_post_upload_uploadId_preview`, `upload.ts:187` schema `UploadAssetPreview`, `uploadFacts.ts:20` route ID `binary_post_upload_uploadId_facts`, and `uploadFacts.ts:21` schema `UploadAssetFacts`. Actual public recovery surface now resolves. These four symbols still require the original canonical Shared/backend observation-to-OpenAPI-to-route producer chain; no generated output, golden append or decoder registry activation was performed. This focused result does not override other owners' differently scoped full-application diagnostics.

Current original71-path style check is FAIL78 findings, owned0: Outline64, locales10, upload1, uploadFacts1, and actual inherited binaryApi2 (`consistent-type-imports` at177:18 and184:18). The JSON `current_snapshot` carries every current path, line, column, rule, message, source head and blob. Original Router8 integration repairs now have zero findings; no rules or baseline exemptions changed. Eleven source SFCs (including both Rail components, both hosts and all seven inherited Writer/layout/editor SFCs) pass parse/script/template/scoped SCSS compilation.

Published commit-range governance remains FAIL for `475aaa0668f7e049220dab6e88a402403321318d`: its `style` type requires a format-only or naming-only declaration that these source transformations do not satisfy. Do not add a false declaration or relax the checker. A non-destructive same-tree local metadata repair candidate exists; published history remains intact and that candidate is not an active published implementation line. All runtime/test/discovery/native/qualification holds above remain unchanged.
