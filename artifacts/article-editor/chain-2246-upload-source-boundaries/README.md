# Historical source evidence: precise upload dependencies and intended UI06d

Related to #2246, #2256, #2258 and tracking-only #1809. Source/coordination evidence
only; no issue, runtime, provider, migration or product acceptance.

Actual source checkpoint: `59ee0eeb4a7e9b82f7787e95c3dcae616bda815e`.
Actual layout target: `f39140f8ecccd4cbe2193c1a2525b6bfb5b6c362`.
The existing f34 offer's34 postimages and17 retained Group/registry/session blobs
are unchanged; this increment does not edit Write.vue or those owners.

## Original implementation owners and usable next actions

The implementation owner is **Blog #2258**, whose current issue owns the
WASM/provider/upload/commit/current AssetId/ledger observation join. Original
observation commit54e99010 explicitly references2258. The original preview275
integration66fa8b0e references2258/1975/2077. These are source references from the
existing history, not freshly authorized sibling commits or accepted prerequisites.
Do not cherry-pick their whole mixed-source scopes.

**#1975** retains sole authority for asset migration/backfill/production cutover.
**#1974** defines the existing closed AssetId/PublicAssetUrlCodec endpoint boundary.
**#2077** is the real upload/filesystem acceptance owner and explicitly does not fix
product defects; it cannot be assigned the missing endpoint implementation.
**#2263** consumes resulting attachment state for save/leave/revision; it does not
own this bytes/provider/ledger implementation.

The parent should request from the original2258 and asset/protocol owners the
small exact source increments below, bound to their actual source/evidence. Source
availability is per file and stage, not a request to wait for a whole chain.

| Missing source at f391 | Exact required symbol or join | Original owner action |
| --- | --- | --- |
| `src/frontend/src/contracts/binaryApi.ts` | `UploadAssetPreviewViewModel`, `UploadAssetFactsViewModel` | Retain all current writing-aid/other declarations; add original two DTO declarations. |
| `src/frontend/src/adapters/binary/uploadAdapter.ts` | `mapUploadAssetPreviewFromPayload`, `mapUploadAssetFactsFromPayload` | Already supplied as a complete postimage in the f34 offer; consume that original decoder source. |
| `src/frontend/src/composition/binaryDecoderRegistry.ts` | Imports, supported-frame entries and decoder registrations for both preview/facts | Add only the original map functions/registrations; preserve every current unrelated decoder. |
| `src/shared/Contracts/Validation/aeds-protocol.json` | `UploadAssetFacts` at285 | Original protocol owner supplies canonical closed manifest/golden metadata;285 is neither allocated nor retired in inspected f391. |
| Generated protocol consumers | Facts285 in `src/shared/AedsFrameHeader.cs`, `src/core/Algorithms/AedsFrameType.cs`, `src/frontend/wasm/aeds/include/aeds_frame.hpp`, `src/frontend/wasm/web/protocol/frame.ts` | Regenerate with the existing protocol producer after the original manifest delta; do not hand-edit enums. |
| `src/backend/Interfaces/IFileService.cs` | `ObserveCommittedUploadAsync`, `ReadCommittedUploadPreviewAsync` | Original2258 observation/preview service contracts, using actual `UploadSessionAccess` and grants. |
| `src/backend/Services/FileService.AssetObservation.cs` | Current committed bytes/ledger observation and same-observation preview | File absent at f391; original2258 owner provides its complete implementation and actual FileService/native/ledger dependencies. |
| `src/backend/Interfaces/UploadAssetObservation.cs`, `UploadAssetPreview.cs` | Original observation and same-observation bytes records | Both absent at f391; original source records, not editor/cleanup authorization receipts. |
| `src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Uploads.cs` | Actual `POST /api/binary/upload/{uploadId}/preview` and `/facts` handlers | Neither route exists in f391 or this Writer source. Preview source reference66fa has `HandleUploadAssetPreviewAsync`; provide a current exact owner delta. No existing facts-handler implementation was found. |
| `src/shared/Contracts/Validation/fsusblog.openapi.json` and `aeds-endpoint-contracts.json` | Both actual endpoint/security/request/response projections | Derive from compiled actual owner endpoints through the existing observation producer, not fabricated snapshot records. |
| `src/frontend/src/generated/fsusBinaryRoutes.ts` | `binary_post_upload_uploadId_preview`, `binary_post_upload_uploadId_facts` | Generate from that same genuine endpoint observation. |

The preview frame275, shared `UploadAssetPreviewDto` / `UploadAssetPreviewPod` and
`PodBinaryCodec.WriteUploadAssetPreview` **already exist at f391**. Preserve them;
do not replace the shared files with this older Writer graph, where those wire
files are absent. The existing native preview POD is likewise in the layout graph.
`exact-missing-upload-source.json` records20 exact path/blob/presence rows for both
target and Writer, including this difference. It is not merely an aggregate blocker.

The required caller contract already in real source is:

- Original64-byte fixed SHA256 `UploadCompleteRequest` payload under the actual
  authenticated upload owner/session grant.
- Preview response frame275/schema`fsusblog.upload-asset-preview.v1`,760-byte
  closed header plus original same-observation bytes.
- Facts response frame285/schema`fsusblog.upload-asset-facts.v1`,exact760-byte
  closed metadata payload with no image bytes. The two current read source graphs
  do not supply its actual backend encoder/endpoint join. Do not invent a named
  service/codec interface to hide that absence.
- Observation grants no article-operation, reference mutation or cleanup receipt.
  Native regular-file and current canonical ledger/ref checks must remain real.

The current Writer has `ObserveCommittedUploadAsync` and its original observation
implementation, but lacks same-observation preview service and both actual routes.
Its committed OpenAPI/generated frontend names therefore do not prove current
source/runtime endpoint availability. The JSON records both directions explicitly.

`layout-f391-upload-consumer-unapplied.patch` provides a minimal two-file consumer
change: original DTO declarations and original decoder registrations. Complete
postimages are under `consumer-postimages/`. Current unrelated writing-aid,
workspace, selection and export declarations/decoders are retained. Actual
`git apply --check` on untouched f391 exits0. It is **UNAPPLIED** and requires the
f34 uploadAdapter plus original generated facts285/route/backend output. No
protocol/generated/backend file was edited, and no partial server activation was
performed. This consumer hunk is not a replacement for the source owner join.

## Exact intended UI and current static results

The coordinator supplied full UI identity
`06d6303f98c0d3f915a19cb777028b2fd9d914d4` from published source PR914. It was fetched,
checked out for static checks and used with the same original locks/verified20
public source dependency aliases and real type-fest4.41.0 dependency. Its manifests
and lock are identical to the previous8afe graph. No private selector, public API
stub or alternate parser was introduced.

The actual06d source still lacks public `MarkdownAttachmentCaptureObservation`,
`MarkdownAttachmentFileConsumer`, native `withAttachmentFile` loan and the accepted
capture argument of `upload-image(batch, capture?)`. It does have a batch-only
`upload-image` event. `attachment-capture` is the Blog wrapper's application event,
not an FsusUI native event; the earlier inventory wording was incorrect. The
existing Blog wrapper already listens to native `upload-image` and passes its
optional capture to that application event, so no product event rename is needed.

Parent supplied original producer PR892 exact
`971e73839896940f8af21b92a1363188a3180c4a`, with original source
`8f69342eb0ce7b02a38d0669b38794728161a53a`. Exact971 was fetched/read only. It has the
two actual exported types, native `withAttachmentFile(originalBatch, originalItem,
consumer): boolean` and `upload-image(batch, capture?)`. The loan validates original
batch/item custody, signals, current document identity/epoch and original pending
job revision/attempt before synchronously lending the File and actual observation.
Those facts are source evidence, not native execution or qualification. Producer
task `01a12481-c8e6-7728-bfbc-81f0a7ebc00c` is preparing a narrow offer for the actual
shared Vue owner to join carefully with UI914. No donor was substituted into06d.
**FsusUI #375** owns picker/paste/drop capture and anchors; **#376** owns native
attachment lifecycle; **#275** is tracking. Closed states do not prove the API join.
The four cascading implicit-any diagnostics and five style findings remain scoped
to the actually tested06d; they cannot be removed with fabricated types/rules.

Parent also resumed original backend #2258 task
`01a1195b-2e86-72e6-a09d-ebac26f4401e`. Its original preview source66fa8b0e is retained
in PR4068/4170 and is preparing narrow closure. The subsequent original offer7e68bb47 recovers actual facts DTO/handler/encoder.
Writer already retained formal275/285 manifest and four projections. Source
gaps are superseded by d27ed27e intake; runtime acceptance remains open. Read references do not authorize broad
cherry-picks or substitute a frontend decoder for the missing backend producer.

Newer supplied `673c342ae42967b9f505d749b3a91f5d261315e6` was fetched/read only. Its
honest actual renderer/attachment resource observations are not full snapshot,
bootstrap or product qualification; no session installer was called here.

Actual original complete-app entry with UI06d/config699:

- Exact9595 baseline: exit2,238 diagnostics.
- Corrected59ee source: exit2,227 diagnostics; eleven removals, zero additions.
- New59ee correction removes two Source-compare constructor parameter properties
  using explicit readonly fields/assignments. It preserves behavior and strictness.

Actual original strict-full style entry over14 baseline/18 candidate paths:
exit1,7→5 findings, zero added findings; remaining five are the same genuine missing
attachment public-type dependency. Original34-postimage layout projection with
06d/config699 remains exit2/267. Its still-unapplied Write private-fields error is
separate from this current Writer's public validation consumer.

The coordinator's independent **f34** source review accepted mounted-association
P2 and indentation, with no new boundedP1/P2. Its type238→229 and old-config lint
12→10 remain bound to that exact source/config. The review-verified699 result7→5
is a separate configuration result; numbers are never mixed or promoted to PASS.
59ee source correction is new and awaits its own rereview.

Exact commands/exits and all removed diagnostics are in
`exact-06d-static-results.json`. Tests/list/collection/mount/native/browser/server/
security/DB/receipt/business/IME/race/UX/performance/a11y/geometry are NOT RUN or HELD.
Original #2245 accepted prerequisite evidence and the existing full snapshot/server
Document binding gaps remain open. All nine execution issues and tracking-only
#1809 remain OPEN/unaccepted; the previous per-issue accounting is unchanged.
No issue closure, merge, deployment, package publication or production migration.

## Later exact source intake

Parent supplied original backend offer PR4226 exact7e68bb47. Source d27ed27e
actually consumes all15 Writer postimages (14 changes), including facts handler,
DTO, encoder and preview service. See `../chain-2246-upload-source-intake/README.md`.
The source59/f391 absence table above is historical, not the current Writer state.
Writer7b/5e already had275/285 canonical entries and all four frame projections;
the earlier Writer missing-manifest wording was incorrect. No frozen authority
refresh or runtime/native/asset qualification follows from source intake.
