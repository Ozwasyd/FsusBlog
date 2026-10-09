# Persisted export choices consumer — source WIP

Issue #2436 remains OPEN. Branch:
`codex/export-api-ui-2436-source-options-20261009`.
Usable product source: `f55a9ec0149fa700b8e55bbf9c1d8ec69cbf4f83`.
This supersedes v3's pending-route statement; its earlier UI and wire validation
remains historical evidence for the unchanged UI/Shared implementation.

## Actual owner interfaces

Original #3653 source `31fb5ab98df812c137fb7a66bd3881aa7f8affb8` publishes:

| API | Request root | Response root |
| --- | --- | --- |
| POST `/api/binary/document-export/sources/capture` | 282 | 284 |
| POST `/api/binary/document-export/sources/revisions` | 283 | 284 |

The actual endpoint registration and source-options handlers require ArticleWrite
and PoW, use the original authenticated site/actor/session context, propagate
cancellation, and retain original no-store typed error behavior. Both calls
persist bindings. Original r2 `726ac992508759b9d7b7b3b778ba72fcbfae8d69` changes
only catalog exception handling and its PostgreSQL integration test; the routes
and DTOs remain identical. This consumer reads those exact sources without
importing server/DI/route files or claiming their runtime qualification.

All 34 consumed Shared paths still match owner
`10b33204607627d167e34f7ad69bcfccaee03b2c` in Git blob and mode. There are no codec,
registry, fixture, producer, checker or job-persistence changes in this increment.

## Exclusive API/UI files and integration

Product source changes only:

- `src/frontend/src/api/documentExportSourceOptions.ts` (new)
- `src/frontend/src/composition/documentExportSourceOptions.ts` (new)
- `src/frontend/src/components/document-export/documentExportSourceChoices.ts`

Regression tests only:

- `tests/frontend/unit/api/documentExportSourceOptions.test.ts` (new)
- `tests/frontend/unit/composables/documentExportSourceOptionsComposition.test.ts` (new)

Public APIs use the sole generated request/response types:

```ts
captureDocumentExportSources(request, signal?);
captureDocumentExportRevisionChoices(request, signal?);
classifyDocumentExportSourceOptionsFailure(error);
captureDocumentExportSourceChoicesResponse(response);
createDocumentExportBrowserUiPortFromSourceCapture(request, host, signal?);
createDocumentExportBrowserUiPortFromRevisionChoices(request, host, signal?);
```

`host` is `DocumentExportSourceOptionsHost`: actual `catalog`, explicit boolean
`privateForSource(choice)`, and original `prepareRequest(selection, choice)`.
The factories await actual authorized choices, then return the existing browser
UI port for the original host to pass to ExportCenter. Navigation, route mounting
and host metadata integration remain original #3653 ownership. The response
supplies no privacy, format capability, availability or locale values.

API calls freeze selectors before asynchronous work, use the sole generated
encoders and registered response root, and retain original admin-scope HTTP,
credentials, PoW and cancellation. Capture responses must match the complete
selected coordinate set; revision enumeration must contain only that article's
revision bindings. Int32 input and decimal-string Int64 coordinates/version stay
exact. No SourceVersion or job identity is allocated by the consumer.

Malformed or mismatched post-write replies remain uncertain. Actual normalized
HTTP 5xx, including transport's `public_artifact_not_ready` 503, also remain
uncertain; uniform permission denial retains priority. There is no automatic
retry. The existing transient command can hold this uncertainty with
`allowUncertainRetry: false`. A later explicitly authorized recapture does not
promise the same SourceVersion: changed source facts can allocate a new binding.

Acquisition checks the original admin generation and caller signal before/after
each private host projection and before returning a port. Revocation or caller
cancellation stops subsequent choice callbacks. The signal cancels acquisition;
after return, the original port's permission lifecycle and the host's unmount
disposal own its lifetime. No second private lifecycle or durable state is added.

## Candidate verification and limits

Official Node 24.16.0 and actual clean FsusUI
`f2b3bb89ffe5f749da26c388f058efdbb6aee864` were used on the exact product source.

- Vitest: **58/58 PASS** across exactly three files: API31, composition11,
  existing source-choice mapping16. The outer HTTP/admission boundary is
  controlled; generated codecs, frame types and response registry are actual.
  Tests include full-set mismatch, exact large integers, permission revocation,
  pre-body admission, cancellation, multi-choice callback revocation, normalized
  5xx and uncertainty without automatic retry. No successful job/output/receipt
  is constructed.
- Canonical frontend style: **PASS**, implementation files3, eslint3,
  stylelint0, violations0. `git diff --check` passes.
- Canonical full application typecheck: **FAILED**, current197 diagnostics are
  identical to the prior candidate baseline197; introduced0, resolved0, export0.
  This remains a failing application gate, not an exemption or full CI pass.
- Independent read-only review identified two defects (callback revocation and
  normalized503); both were fixed and covered by the final regressions. The
  second review found no new concrete defect. It did not run SOURCE or tests.
- This increment changes no UI markup, style, bridge or Shared code. The earlier
  v3 actual Chromium/UI and native wire checks are not rerun or represented as
  this increment's authenticated HTTP/provider acceptance. The v3 full strict
  FsusUI boundary check remains FAILED with five unrelated baseline findings.

Commands, run from the repository unless indicated:

```sh
# From src/frontend, using official Node24's node:
node node_modules/vitest/vitest.mjs run ../../tests/frontend/unit/api/documentExportSourceOptions.test.ts ../../tests/frontend/unit/composables/documentExportSourceOptionsComposition.test.ts ../../tests/frontend/unit/composables/documentExportSourceChoices.test.ts
node tools/frontend/check-frontend-style.mjs --mode changed --file src/frontend/src/api/documentExportSourceOptions.ts --file src/frontend/src/composition/documentExportSourceOptions.ts --file src/frontend/src/components/document-export/documentExportSourceChoices.ts
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application
```

Actual authenticated capture/server/catalog/PoW, source reader/freezer, live host
capability/privacy/locale preparation, provider output, private grants/receipts
and independent runtime acceptance remain unqualified here. Existing request,
status, cancel, retry and private download code continues to consume the sole
#2434 job contract; no second store or receipt authority is introduced.

Rollback this increment if original route or host contracts change: remove these
consumer factories/calls while preserving canonical Shared and job ownership.
No database or durable-job migration is introduced.

This task did not dispatch remote CI. No PR/body/comment/label/ready/merge action,
package publication, deployment or guard weakening was performed. Previously
rejected SOURCE raw-log/plan/result publication remains stopped; none of that
payload is copied or republished in this source handoff.
