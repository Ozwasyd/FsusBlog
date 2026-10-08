# Export typed consumer source handoff

This is source WIP on frozen component `6402b4e1d1d3227003658a0b0c5c0bfb2e4459bf`, not production activation. Domain implementation commit: `295cf732b067c9c788fc515fbeb155dfb0c450fa`; download response-header refinement: `cacac8cac6f09227cc23e77c7238a2decddb46e4`. Eight Shared source/product/helper files are consumed byte-for-byte from sole owner `8464d9667f6de4fd159718bc65c32868df022d5d`; generic frame/native/response registration files are untouched.

## Usable domain APIs

`src/frontend/src/api/documentExport.ts` consumes original `requestBinaryOnly`, `binaryRequest`, `encodeAedsFrame`, the admin private-generation lease and the sole generated Export codecs. No body user/site facts, numeric frame fallback, additional parser or persistence are introduced.

- `captureDocumentExportRequest(request: DocumentExportRequest): DocumentExportRequest` freezes the exact source and request/idempotency identity and validates through the generated encoder.
- `requestDocumentExport(request, signal?): Promise<DocumentExportJobResponse>` verifies the actual response matches the submitted request/source/format/options/locale. Post-send mismatch is **uncertain**, preserving the captured write/retry identity.
- `listDocumentExports(offset, limit, signal?): Promise<DocumentExportPageResponse>` admits a bounded requested page and requires its actual coordinates.
- `getDocumentExport`, `cancelDocumentExport`, `retryDocumentExport`, `deleteDocumentExport`: `(taskId, signal?) => Promise<DocumentExportJobResponse>`. Only existing status is read-only; mutations retain original PoW/admin controls.
- `downloadDocumentExport(taskId, signal, deliver): Promise<void>` uses the real raw private endpoint with credentials/CSRF/PoW, checks admin generation and cancellation in the original response-header callback before the transport reads the body, verifies actual response metadata and byte length, and checks again before the original delivery callback. Grants, paths and URLs are not returned to UI. `deliver` is required and must honor the provided signal through its actual save boundary; no default browser saver or successful output is invented.
- `classifyDocumentExportFailure(error)` preserves uncertain transport/response outcomes and privacy-safe permission denial separately from pre-send refusal.

`src/frontend/src/components/document-export/documentExportWireUiPort.ts` exposes `createDocumentExportWireUiPort({catalog, sources, prepareRequest, deliverPrivate})` and `inspectDocumentExportWire(snapshot)`. Sources carry the sole generated `DocumentExportSource` coordinate; preparation must match the selected coordinate and closed options. Catalog/source/request identity and actual delivery are supplied by original authorized adapters. Missing warnings and safe filename remain unavailable. All version/output byte Int64 strings remain exact.

The only existing domain source repair is `useDocumentExport.submit`: preparation/capture failures are caught at the pre-send boundary; refusal is announced and permission denial clears private views. No unhandled preparation Promise or synthetic job transition remains.

## Ordinary verification

Exact positively selected frontend119/119: unchanged original82 plus new API28 and typed UI9. Only six explicit own files ran, with canonical setup/hooks inspected; no held aggregate or shared integrity audit suite ran. The exact preflight multiset matches all119 observed passing cases, including two unchanged existing cases with the same display title. The two additional API cases require zero response-body reads and zero delivery when cancellation or an admin-generation change precedes response headers. Strict frontend style/lint4files passed at295cf732b; the only subsequent source change, the API header refinement, independently passed strict lint with0violations. Full canonical application typecheck remains FAILED with the same237 diagnostics as exact component6402, introduced0/export0. Existing backend/DTO/codec/golden/control inputs are unchanged from6402; its96 result is reused by verified input identity, not claimed as a new backend run. This task did not dispatch remote CI.

Controlled browser validation at295cf732b passed on Chromium with real FsusUI `f2b3bb89ffe5f749da26c388f058efdbb6aee864`, the actual generated queued golden and typed UI port:1366x768 desktop/light and390x844 mobile/dark/reduced-motion. Both captured screenshots were visually inspected. Both cases projected the exact source coordinate and Int64 version, refused missing frame registration before HTTP, announced refusal, cleared private views after preparation revocation, and had no overflow, page errors or console errors; actual binary requests0. This did not run generic/native/private-output/HTTP activation. It predates the download-only refinement and is not claimed as a new browser run for that refinement. Controlled transport/native bindings are never production or private output qualification. New test frame bindings read the sole owner's literal `document-export-wire.json`, rather than allocate IDs. Read-only domain review accepted the response-header ordering; independent integration review remains required.

Exact six-file command from `src/frontend` (with the real FsusUI checkout and existing dependencies):

```sh
FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  ../../tests/frontend/unit/api/documentExport.test.ts \
  ../../tests/frontend/unit/api/documentExportWireConsumer.test.ts \
  ../../tests/frontend/unit/components/DocumentExportCenter.test.ts \
  ../../tests/frontend/unit/components/DocumentExportRejectedAction.test.ts \
  ../../tests/frontend/unit/composables/documentExportWireUi.test.ts \
  ../../tests/frontend/unit/composables/useDocumentExport.test.ts
```

The119-case preflight SHA256 is `8dd0cda6eac3258819e3dc84d13e92fa8de3d781dd8c7784f92d17f38a4142ca`; actual Vitest JSON SHA256 is `126fe5dc847704c878193f3934630723c2f7a660e1c1a92b90785ca03a53f6c6`. These identify this local ordinary run, not an uploaded receipt or a production export.

## Exact incremental file boundary

Relative to frozen6402,14 paths: five owned source/test paths, eight published Shared prerequisites, and this portable handoff. The frozen6402 branch is unchanged. API/UI does not edit shared registration, original transport, backend integration, job lifecycle or storage.

Owned:

```text
src/frontend/src/api/documentExport.ts
src/frontend/src/components/document-export/documentExportWireUiPort.ts
src/frontend/src/composables/useDocumentExport.ts
tests/frontend/unit/api/documentExportWireConsumer.test.ts
tests/frontend/unit/composables/documentExportWireUi.test.ts
artifacts/document-export-api-ui/wire-consumer-handoff-v1.md
```

Exact published Shared8464 prerequisites:

```text
src/shared/Contracts/Validation/document-export-wire.json
tools/contracts/generate-document-export-wire.mjs
tools/contracts/document-export-wire-templates/wire.ts.inc
tools/contracts/document-export-wire-templates/wire.hpp.inc
tools/contracts/format-generated-property-value-read-typescript.mjs
src/frontend/src/codecs/binary/documentExportWire.generated.ts
src/frontend/wasm/aeds/include/document_export_wire.generated.hpp
src/frontend/wasm/aeds/include/writing_aid_preference_wire.generated.hpp
```

## Exact missing Shared registration closure

Baseline6402 has244 `frameTypes`, maximum value252, and no `reservedFrameValues` property. Actual `node tools/contracts/generate-document-export-wire.mjs --check` fails at line31 with `TypeError: Cannot read properties of undefined (reading 'find')`. No output, gate or contract was hand-repaired.

Published8464 has273 frame records. Its four Export records are already allocated as278/279/280/281, with goldenOrder269/270/271/272. Simply appending those four records to baseline yields248 records; the sole `tools/frontend/generate-aeds-protocol.mjs` lines101–106 rejects any goldenOrder >= frameTypes.length and duplicate order. Copying complete registries imports unrelated253–277 roots and missing typed modules/native validators. A sole3735-compatible current-base increment is therefore required, preserving assigned wire values and original guards; API/UI does not reallocate or independently adapt these registration surfaces.

Required owner closure: original `aeds-protocol.json`, its five producer products (Core/Shared enum, native frame header, TS frame constants and golden catalog), Export native error/envelope/inner validation increments, and the two Export response registrations in the existing unique registry. The original integration owner retains route descriptors, backend DI/route activation, real freezer/auth composition and UI/navigation wiring. No whole70-issue acceptance is required to provide this source increment.

## Int64 allegation corrected by actual reproduction

The previously suspected newline-normalization defect is **not reproduced and withdrawn**. Exact8464 `src/frontend/src/codecs/binary/documentExportWire.generated.ts:329` `integer64`, invoked by `encodeDocumentExportRequest` at659, rejects articleId `"1\n"`, `"1\r"`, `"1\u2028"`, `"1\u2029"`, `"01"`, `" 1"` and `"+1"` with `RangeError("document_export_payload_invalid")`; there are no encoded bytes or decoded output. Canonical `"1"` encodes and decodes as `"1"`. The exact non-multiline anchored regex returns false for the newline inputs. The corresponding owner template is `tools/contracts/document-export-wire-templates/wire.ts.inc:18`; no Shared patch should be requested on this disproved basis.

## Remaining activation/runtime boundary

Original3653 supplies real `IDocumentExportRequestFreezer`, session/source/site permission composition, catalog/source choices, original delivery saver and generic DI/routes/navigation. Actual authenticated HTTP/native/browser admission, real provider output, authorized private grant/download and assistive speech qualification remain WIP. Issue2436 stays OPEN. Source push only; no GitHub content writes, security changes, guard weakening, deployment or merge.
