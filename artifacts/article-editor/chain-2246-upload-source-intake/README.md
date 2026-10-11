# Historical source intake: original Writer upload endpoint and codec closure

Source WIP and coordination evidence, not runtime, native, asset/business or product
acceptance. Related to #2246, #2256, #2258 and #1975.

Actual intake: `d27ed27e0e998955466ae2c4f70b599446f4d613`, based on
`dc98ae399932efa5445b6d4b4781e6ca17b37cd7`, branch
`codex/chain-2246-preack-runtime-intake`, draft PR4153.
Parent authorized original source offer PR4226 exact
`7e68bb47f1d11723b57b045649ca5fc510ed3ea5` and its complete Writer5e-target closure.
All15 current dc98 preimages matched. Actual apply-check/index application,
all15 postimage byte comparisons and reverse-check succeeded, with no conflict.
The patch changes14 files and retains exact original UploadAssetObservation as
its15th postimage. No broader branch or second owner implementation was consumed.

## Actual source join

The original ArticleWrite/PoW upload group now wires
`MapBinaryUploadAssetFactsEndpoints` and actual `HandleUploadAssetFactsAsync`.
It reads the original fixed64-byte UploadCompleteRequest through original request
machinery, requires original admin principal and ArticleWrite, and calls original
`ObserveCommittedUploadAsync` under original owner/token/completed-upload access.
The actual facts DTO goes through original `WriteUploadAssetFacts`, frame285,
with a760-byte closed metadata payload, no image bytes.

The actual preview handler calls original `ReadCommittedUploadPreviewAsync` and
returns the760-byte header plus original same-observation bytes, frame275.
The8,387,832 preview-byte limit keeps payload plus16-byte AEDS header below8MiB.
Facts20MiB does not bypass original file, media/hash and ledger observation.
No JSON/URL fallback, second ledger/provider/queue, weakened permission or
article/reference/cleanup/Vault receipt was added.

The closure supplies IFileService, original service/preview record, actual DTO/POD,
C# encoder and native parser source. Original session expiry/token checks,
AssetId1779 lock, regular-file identity/bytes/media checks and canonical asset/
reference ledger remain. Native760-byte/layout assertions and closed parser
source exist; they were not executed as ABI/parser acceptance.

The existing real Writer path remains: original accepted capture/File custody and
pending handle -> original upload flow -> private caller-held session loan ->
original AttachmentUploadProvider -> authenticated status and preview/facts reads.
Its callback retains original File/intent/attempt equality, cancellation and
recovery obligations. Observed asset facts do not authorize a document operation;
the later business-authorized transaction remains outside the loan callback.
Existing consumers now have actual server/codec source counterparts. No frontend
upload or save flow was rewritten merely to consume equivalent existing source.

## Protocol and preserved source

Writer7b/5e and current dc98 already contain263 canonical frames, with
Preview275/order261 and Facts285/order262 and both names in all four C#/TS/C++
frame projections. Earlier Writer missing-manifest wording was incorrect; the
prior missing join was endpoint/service/DTO/POD/codec. Master9d72 differs and still
requires its canonical Shared owner closure. Writer's roster is not a master
manifest transplant or golden/native/runtime qualification.

No manifest/frame enum was overwritten or generated. OpenAPI, generated operation
IDs/routes and endpoint catalog remain exact prior bytes. Their presence is not
runtime observation after a source handler join. Golden catalogs, matrix, receipts
and frozen qualification authority were not regenerated/refreshed. Writer's
composable/save flow and old journal retain exact dc98 bytes. Write.vue, frames,
Group/registry/session and unrelated shared outputs were not edited.
Ten preserved path hashes and all15 exact postimages are recorded in
intake-verification.json. The changed-path list is exactly the14 offered paths.

## Actual static verification and remaining gates

Original frontend application type entry, actual d27 source with its old journal,
public UI06d and canonical699 config overlays: exit2,234 diagnostics. Three missing
journal exports/method and four cascading implicit-any errors account for seven
additional diagnostics relative to the earlier exact61 journal projection227.
That projection is not actual main compilation.

Original strict-full style over six unchanged upload consumer files: exit1, two
existing import()-type findings at binaryApi.ts lines177/184, in unmodified locale
#1706 source. No new upload style finding was reported; unrelated fields remain.
Commands/exits/log SHA/source blobs are in static-results/source-symbol-bindings.
The initial artifact inventory used the wrong JSON key, frames rather than actual
frameTypes; it was corrected without changing product source or authority.

C#/native compilation, tests/list/collection/mount/native/backend/browser/product
execution, migration/DB/backup/security/current receipt/race acceptance: NOT RUN.
No frozen authority refresh. #1975 asset/native/migration holds, #1976 waiting,
canonical business receiver/intent/reference grants and current product/custody
gates remain. UI06d's public attachment capture/file-loan join is still separate.

The original journal61 stale async restore/list P2 and stable ref are being fixed
by its sole owner. That dependency and the original intake security-doc conflict
remain unresolved. Parent reports independent review ofdc98; no runtime upgrade
follows. Full factory/draft/server Document identity, external #2245 evidence and
real continuity/attachment/product acceptance remain open. Execution issues
#2246/#2250/#2253/#2256/#2280/#2282/#2284/#2286/#2287 remain unaccepted;
#1809 is tracking-only with incomplete child evidence.
