# Export source-options client — source WIP

Issue #2436 remains OPEN. Published branch:
`codex/export-api-ui-2436-source-options-20261009`.
Usable product source: `6860af985caba3d83126b5e6b8ea521ea728a3c4`.
No PR, body, comment, label, ready or merge action is performed by this worker.

## Exact source foundation

This branch starts from `9d72a1c93b297f719d8695a642cdfb1615cf1d51` rather than
combining the current-master registry with the old aggregate's 25 other domains.
The previously published `13ed8045650765dfa35583c0609fa47659b02e8b` remains preserved.

`b30e084b7` consumes all 34 original Shared-owner paths from
`10b33204607627d167e34f7ad69bcfccaee03b2c` with exactly that source's Git blobs and
regular modes. No codec, registry, generator, fixture or checker is independently
edited. `2319f9593` then consumes only the 12 exact API/UI-owned files from 13ed,
including the original private saver, permission-generation lifecycle and tests.
It does not copy that branch's old generic registry or unrelated contracts.

Actual source-options authority is
`docs/api/document-export-source-options.md` and the sole generated
`documentExportSourceOptionsWire.generated.ts`: roots 282/283/284, choices-only
response, maximum 50, positive Int32 request ArticleId, canonical decimal-string
Int64 response coordinates and independent SourceVersion.

## New owned APIs

`32fbdee1f` changes only:

- `src/frontend/src/components/document-export/documentExportSourceChoices.ts`
- `tests/frontend/unit/composables/documentExportSourceChoices.test.ts`

It exports:

```ts
captureDocumentExportSourceCaptureRequest(
    request: DocumentExportSourceCaptureRequest
): DocumentExportSourceCaptureRequest;

captureDocumentExportRevisionChoicesRequest(
    request: DocumentExportRevisionChoicesRequest
): DocumentExportRevisionChoicesRequest;

mapDocumentExportSourceChoices(
    response: DocumentExportSourceChoicesResponse,
    privateForSource: (choice: Readonly<DocumentExportSourceChoiceResponse>) => boolean
): DocumentExportWireUiOptions['sources'];
```

All request/response types above come from the sole Shared-generated module.
The sole generated encoder enforces the grammar, distinctness and bounds before
host projection. Capture copies and freezes unbound selectors; it neither adds
SourceVersion nor allocates jobs or binding identities. Mapping retains the exact
ChoiceId, Unicode label and coordinate, freezes them, and requires explicit actual
host privacy for every source. It does not infer privacy, formats, availability
or locale, and never converts an Int64 to Number or derives its version from a
revision/publication. The result plugs into the existing wire UI port and its
original admission preparation checks. There is no HTTP route guess, new codec,
second state machine, private source store or receipt authority.

## Export center public-control boundary

`6860af985` changes only:

- `src/frontend/src/views/admin/article/ExportCenter.vue` (imports only)
- `src/frontend/src/fsusui/documentExportControls.ts`
- `tests/frontend/unit/fsusui/documentExportControls.test.ts`

The existing button and classicSelect bridges are reused. The sole new narrow
bridge re-exports public drawer, radio/group, checkbox, table V2 and auto-resizer
objects under Blog names. It adds no wrappers/casts/markup/CSS or component policy.
Existing bridge files, barrel mapping and boundary checker remain unchanged.
Template, props, permissions, lifecycle and every original UI assertion are intact.
Runtime identity tests confirm all nine controls are the actual original public
objects, including classic ElSelect/ElOption distinct from ElSelectV2.

## Fresh focused validation

Official Node 24.16.0 and actual clean local FsusUI
`f2b3bb89ffe5f749da26c388f058efdbb6aee864` were used.

- Exactly four frontend files: source choices 16, bridge identity 10, original
  center 16 and original rejected-action 1: **43/43 PASS**. Original two UI test
  files remain byte-identical to master9d72. The actual registered consumer file
  separately passes **7/7** against this new canonical closure. No old 82/96 suite
  or aggregate rerun is claimed.
- Source-options wire owner tests: **11/11 PASS**, including actual compiled native
  dispatcher/error19/budgets/CRC/resource checks. The three original producers
  (`generate-document-export-source-options-wire`, `generate-document-export-wire`,
  `generate-aeds-protocol`) pass `--check`. This does not qualify live HTTP or a
  provider output.
- Canonical frontend style: 3 files, eslint3/stylelint1, zero violations.
- Canonical full application types remain **FAILED**: exact pre-change `2319f9593`
  and current source each emit **197 identical diagnostic lines**, introduced0,
  resolved0, export scope0. The old 202 count is not used as this candidate's
  baseline and does not exempt the check.
- Actual unchanged strict boundary checker: exact pre-change tree has6 findings;
  current tree has5, with only the ExportCenter runtime-import finding removed.
  The remaining findings are AdminArticleCompactCard (.el-tag),
  ArticleMetadataPropertyList/ArticleRelationGraph (package runtime imports),
  Login/Register (.el-checkbox__label). Full boundary remains **FAILED**; no
  checker or allowlist was weakened.
- Real Chromium 1366x900/light and390x844/dark/reduced-motion: actual public controls
  select the literal source-options golden's Unicode label, format/layout/theme,
  and confirmation. Old private form/details/choices clear on original admin
  revocation; focus returns to the task heading. A fresh host port restores its
  supplied choices while the old selection/confirmation/tasks remain cleared.
  No horizontal overflow, page errors or Export POSTs. Selected/replacement
  screenshots are inspected. These are controlled literal owner fixtures,
  including only an output-null queued job, not authenticated capture evidence.
- The first browser probe could not click the radio's covered native input;
  using its visible public label corrected the test. No product code was changed
  for this. Native checked/enabled state is verified again after two animation
  frames before screenshot capture. Failed probe log remains local.
- Independent read-only review found no concrete defect in the new mapping,
  narrow bridge or imports-only UI change. It did not run SOURCE or write code.

## Exact remaining original-owner integration

The checked published original #3653 branch head was
`43633346da5b203587a9ce788884c49641759f80`; it contains no source-capture/revision-choice
route registration or endpoint reference to the formal source-options roots.
The coordinator reports these two real write/PoW POST endpoints are under
implementation. Their actual published paths, typed error/denial behavior,
actor/session scope and safe retry/uncertainty semantics must be supplied before
this worker can implement the concrete client HTTP calls. Both captures persist
bindings; they must not be exposed as zero-write GETs.

The response has no formats, private or locale fields. The original host must
still supply actual authoritative privacy policy, capability/admission availability,
layout/theme and locale plus original request/idempotency preparation. This branch
does not insert available=true, private=false or guessed defaults to fill that gap.
Navigation/routes/DI, freezer, real server/capture/store/PoW, provider output,
grants/receipts and production runtime acceptance remain original-owner work.

This task did not dispatch remote CI, publish packages, deploy, merge or weaken
any guard. Previously denied SOURCE raw-log/plan/result publication remains stopped;
none of that payload is copied or republished here.
