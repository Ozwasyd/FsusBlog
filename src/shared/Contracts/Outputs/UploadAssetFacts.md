# Original committed upload facts payload source

This ordinary source restores the original facts-v1 metadata DTO/codec from
`4cfdbbf9542f14eab305642aabb968fb6b3179bd` and its exact native header parser,
plus the original neutral FactsViewModel block from
`c08ace9061492fbfab1dea8d57928a998938dcc8`. The current source base is upload
handoff4322 `2538551d305a7ab41e66ac539d52a64f88c8ff3d`; its independent source
review is pending. Its preview DTO/POD/codec dependencies are byte-identical to
the original3735 lineage `a27a5c1922d681d9796a05acdd7f424362f26869`.

## Payload only, independent of frame allocation

`UploadAssetFactsDto` describes actual session-authorized committed asset metadata:
upload/asset identity, canonical public path, MIME/extension, actual size/dimensions,
content/version/reference-ledger SHA256 and reference row count. It carries no
image bytes or private reference rows, article/Vault/operation receipt or grant.
The original packed `UploadAssetPreviewPod` is the common760-byte metadata layout;
its field order/offsets/Pack=1 are unchanged. Facts-v1 requires exactly760 bytes,
the independent facts schema, the original20MiB upload size bound and all original
canonical identity/MIME/path/ASCII-padding/hash/dimensions/count/reserved checks.
Preview keeps its own schema, existing8MiB frame-derived bound and exact original
image-byte tail. Neither schema can decode as the other.

Managed helpers encode/decode the payload without an AEDS header or frame ID. The
existing handwritten native metadata parser exposes `ParseFacts` with the same
facts-only constraints; no active native frame dispatch is added. The ordinary
neutral FactsViewModel uses the already real PreviewViewModel field shape while
removing schema/bytes and declaring the genuine facts schema. It is not an ambient
declaration, preview response substitution or fabricated server producer.

## Exact remaining owners and HOLD

The real upload owner now supplies
`IFileService.ObserveCommittedUploadAsync(UploadSessionAccess,string,CancellationToken)`
returning `Task<Result<UploadAssetObservation>>` in4322. This source does not
duplicate its service, session/token/media/native-file/asset/reference ledger or
endpoint work. The original upload owner must consume the shared payload from
that actual observation after a current canonical frame allocation is supplied.

No current Facts frame value, golden order or active roster is chosen here.
Historical285 is not current authority; preview275 resolves only preview. The
old provisional preview253 collision with Canvas remains a genuine refusal.
No manifest, enum/header/frame constants, native active switch, decoder registry,
endpoint, routes, golden/matrix/inventory/receipt/OpenAPI product is changed or
regenerated. Payload source and static compilation do not authorize registration
or runtime consumption. Existing consumer errors for missing Facts frame/operation
remain gates rather than receiving a guessed ID/route.

Canonical API projection belongs to the original parent-assigned API projection
session under3735, not a newly guessed owner. Its genuine compiled endpoint/API
fact observation must update `fsusblog.openapi.json` and aeds-endpoint-contracts
before the original frontend-route producer can supply preview/facts operation IDs.
`check-openapi-sync.mjs` executes the held fact observer and writes receipt/projection
artifacts even in its flow; it is not run. Ordinary source permission is not a
release of those actual execution/frozen HOLDs.

Ordinary payload/POD/negative controls are uncompiled and UNRUN. Actual product
imports, tests/discovery, native codec execution, HTTP/session/DB/file/security/
privacy/browser/physical alias and frozen qualification remain HOLD. Static
compilation is not parity/runtime/product acceptance. #3735/#3736/#3738 and the
upload assignment remain WIP. Revert only this ordinary payload increment before
activation; no allocation, live upload authority or persistent data changed.
