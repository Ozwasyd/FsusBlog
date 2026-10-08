# Document Export wire source handoff

This increment consumes the exact proposal `aa1e3d24318651a5208083bc956a817098a6ecc6`, artifact `artifacts/document-export-api-ui/registration-proposal-v1.json`, SHA256 `c8044059b105e951ed9a0d3142224754da8e07fc14ecccfca7199c1054edac1c`. The model, managed codec and five literal payload goldens were already published at `7e1aee282849ba069a6e81d3592faadc6b9ac0e2`. They remain byte-identical to that supplied owner source.

Root #3735 activates the four previously reserved identities through the sole Shared manifest and original five-product producer:

| Root | Value | Golden family | Payload / complete frame bytes |
| --- | --- | --- | --- |
| DocumentExportRequest | 278 | document-export-request | 16368 / 16384 |
| DocumentExportTaskRequest | 279 | document-export-task-request | 1008 / 1024 |
| DocumentExportJobResponse | 280 | document-export-job-response | 32768 / 32784 |
| DocumentExportPageResponse | 281 | document-export-page-response | 2097152 / 2097168 |

Native `ErrorCode.DocumentExportPayloadInvalid = 18` maps to `document_export_payload_invalid`. Existing common envelope guards retain their order. Only recognized Export roots check zero flags and their own payload/frame budget before CRC. An in-budget bad CRC remains error6; malformed inner grammar after a valid CRC is error18. Errors retain Unknown0/null payload/zero length and no authority facts.

`tools/contracts/generate-document-export-wire.mjs` binds the complete exact Core record fields and managed codec hash against `src/shared/Contracts/Validation/document-export-wire.json`. It owns TypeScript and native products. TypeScript exports all seven complete DTO shapes and `encode/decodeDocumentExport{Request,TaskRequest,JobResponse,PageResponse}`. All Int64 fields are canonical decimal strings. Strict UTF8, UTF16 limits, C0/C1 controls, exact whitespace, nullable/boolean tags, closed source kinds/formats/statuses, timestamp and count bounds, ordered attempts and unique page task identities match the supplied managed codec. Nested page jobs do not introduce another payload revision. Digest strings are validated for shape only.

The existing unique `composition/binaryDecoderRegistry.ts` adds only JobResponse and PageResponse to both its response catalog and mapper registrations. Request codecs remain standalone producer exports. No endpoint, DI, source freezer, job allocation, provider selection, lifecycle, receipt admission or download implementation is created here. #2436/#3653 remain owners of those consumers. They can bind their existing typed facade/endpoint to these exact frame and codec names after receiving this increment's published SHA and current evidence from the parent.

Ordinary protocol verification covers the original five literal managed goldens, unchanged original236 golden oracle, original52 renderer controls, TypeScript/native grammar and envelope refusals, full Int64 values, Unicode and maximum bounds. Exact committed run identities and results are recorded separately after compilation and execution. Source, codec and native controls do not establish real HTTP/session/Postgres/provider/rendered UX acceptance; those gates remain OPEN.
