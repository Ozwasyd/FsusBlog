# Export typed consumer source handoff

This is source WIP on frozen component `6402b4e1d1d3227003658a0b0c5c0bfb2e4459bf`, not production activation. Domain implementation commit: `295cf732b067c9c788fc515fbeb155dfb0c450fa`. Eight Shared source/product/helper files are consumed byte-for-byte from sole owner `8464d9667f6de4fd159718bc65c32868df022d5d`; generic frame/native/response registration files are untouched.

## Usable domain APIs

`src/frontend/src/api/documentExport.ts` consumes original `requestBinaryOnly`, `binaryRequest`, `encodeAedsFrame`, the admin private-generation lease and the sole generated Export codecs. No body user/site facts, numeric frame fallback, additional parser or persistence are introduced.

- `captureDocumentExportRequest(request: DocumentExportRequest): DocumentExportRequest` freezes the exact source and request/idempotency identity and validates through the generated encoder.
- `requestDocumentExport(request, signal?): Promise<DocumentExportJobResponse>` verifies the actual response matches the submitted request/source/format/options/locale. Post-send mismatch is **uncertain**, preserving the captured write/retry identity.
- `listDocumentExports(offset, limit, signal?): Promise<DocumentExportPageResponse>` admits a bounded requested page and requires its actual coordinates.
- `getDocumentExport`, `cancelDocumentExport`, `retryDocumentExport`, `deleteDocumentExport`: `(taskId, signal?) => Promise<DocumentExportJobResponse>`. Only existing status is read-only; mutations retain original PoW/admin controls.
- `downloadDocumentExport(taskId, signal, deliver): Promise<void>` uses the real raw private endpoint with credentials/CSRF/PoW, verifies actual response metadata and byte length, and checks admin generation and cancellation before the original delivery callback. Grants, paths and URLs are not returned to UI. `deliver` is required and must honor the provided signal through its actual save boundary; no default browser saver or successful output is invented.
- `classifyDocumentExportFailure(error)` preserves uncertain transport/response outcomes and privacy-safe permission denial separately from pre-send refusal.

`src/frontend/src/components/document-export/documentExportWireUiPort.ts` exposes `createDocumentExportWireUiPort({catalog, sources, prepareRequest, deliverPrivate})` and `inspectDocumentExportWire(snapshot)`. Sources carry the sole generated `DocumentExportSource` coordinate; preparation must match the selected coordinate and closed options. Catalog/source/request identity and actual delivery are supplied by original authorized adapters. Missing warnings and safe filename remain unavailable. All version/output byte Int64 strings remain exact.

The only existing domain source repair is `useDocumentExport.submit`: preparation/capture failures are caught at the pre-send boundary; refusal is announced and permission denial clears private views. No unhandled preparation Promise or synthetic job transition remains.

## Ordinary verification

Exact positively selected frontend117/117: unchanged original82 plus new API26 and typed UI9. Only six explicit own files ran, with canonical setup/hooks inspected; no held aggregate or shared integrity audit suite ran. Strict frontend style/lint4files passed. Full canonical application typecheck remains FAILED with the same237 diagnostics as exact component6402, introduced0/export0. Existing backend/DTO/codec/golden/control inputs are unchanged from6402; its96 result is reused by verified input identity, not claimed as a new backend run. This task did not dispatch remote CI.

Controlled browser validation is reported separately; mock transport/native bindings are never production or private output qualification. New test frame bindings read the sole owner's literal `document-export-wire.json`, rather than allocate IDs. Independent review of this new increment remains required.

## Exact missing Shared registration closure

Baseline6402 has244 `frameTypes`, maximum value252, and no `reservedFrameValues` property. Actual `node tools/contracts/generate-document-export-wire.mjs --check` fails at line31 with `TypeError: Cannot read properties of undefined (reading 'find')`. No output, gate or contract was hand-repaired.

Published8464 has273 frame records. Its four Export records are already allocated as278/279/280/281, with goldenOrder269/270/271/272. Simply appending those four records to baseline yields248 records; the sole `tools/frontend/generate-aeds-protocol.mjs` lines101–106 rejects any goldenOrder >= frameTypes.length and duplicate order. Copying complete registries imports unrelated253–277 roots and missing typed modules/native validators. A sole3735-compatible current-base increment is therefore required, preserving assigned wire values and original guards; API/UI does not reallocate or independently adapt these registration surfaces.

Required owner closure: original `aeds-protocol.json`, its five producer products (Core/Shared enum, native frame header, TS frame constants and golden catalog), Export native error/envelope/inner validation increments, and the two Export response registrations in the existing unique registry. The original integration owner retains route descriptors, backend DI/route activation, real freezer/auth composition and UI/navigation wiring. No whole70-issue acceptance is required to provide this source increment.

## Int64 allegation corrected by actual reproduction

The previously suspected newline-normalization defect is **not reproduced and withdrawn**. Exact8464 `src/frontend/src/codecs/binary/documentExportWire.generated.ts:329` `integer64`, invoked by `encodeDocumentExportRequest` at659, rejects articleId `"1\n"`, `"1\r"`, `"1\u2028"`, `"1\u2029"`, `"01"`, `" 1"` and `"+1"` with `RangeError("document_export_payload_invalid")`; there are no encoded bytes or decoded output. Canonical `"1"` encodes and decodes as `"1"`. The exact non-multiline anchored regex returns false for the newline inputs. The corresponding owner template is `tools/contracts/document-export-wire-templates/wire.ts.inc:18`; no Shared patch should be requested on this disproved basis.

## Remaining activation/runtime boundary

Original3653 supplies real `IDocumentExportRequestFreezer`, session/source/site permission composition, catalog/source choices, original delivery saver and generic DI/routes/navigation. Actual authenticated HTTP/native/browser admission, real provider output, authorized private grant/download and assistive speech qualification remain WIP. Issue2436 stays OPEN. Source push only; no GitHub content writes, security changes, guard weakening, deployment or merge.
