# Original consumer API and File association

Tested source: `9461d18fb5fd010ad69c14ca76fc1ddee4ac4a18`. Branch:
`codex/chain-1975-runtime-attempt-borrow`. This is ordinary runtime/flow source
and unit evidence. Writer and public editor input integration are not accepted.

The existing interfaces in `useImageUploadRuntime.ts` are:

```ts
interface ImageUploadAttemptBinding {
    readonly owner: ArticleAttachmentContextAdapter;
    readonly intent: ArticleAttachmentPendingHandle;
    readonly documentOwner: ArticleDocumentContextAdapter;
    readonly lease: ArticleDocumentTaskLease;
    readonly getBinding: () => ArticlePositionMapBinding;
}
interface ImageUploadSessionAccess {
    readonly uploadId: string;
    readonly uploadToken: string;
    readonly sha256: string;
    readonly totalBytes: number;
    readonly commitMayHaveStarted: boolean;
}
interface ImageUploadSessionBorrow {
    readonly signal: AbortSignal;
    isCurrent(): boolean;
    withSession<T>(read: (session: ImageUploadSessionAccess, signal: AbortSignal) => Promise<T>): Promise<T>;
    release(): void;
}
interface ImageUploadRuntimeOptions {
    wasmOnly?: boolean;
    bypassCompression?: boolean;
    targetFormat?: string;
    attemptBinding?: ImageUploadAttemptBinding;
    onSessionReady?: (borrow: ImageUploadSessionBorrow) => void | Promise<void>;
}
// Existing runtime return methods:
// uploadFile(file: File, options: ImageCompressionOptions,
//            runtimeOptions?: ImageUploadRuntimeOptions): Promise<string>
// borrowCurrentSession(): ImageUploadSessionBorrow | null
```

The original flow exposes `startUpload(params: StartUploadParams): Promise<void>`
and `resumeUpload(overrides?: UploadCallbacks & { messages?: UploadMessages }): Promise<void>`.
Its per-call callbacks retain `onSuccess` and `onError` and add:

```ts
interface ImageUploadFileCompletion {
    readonly file: File;
    readonly intent: ArticleAttachmentPendingHandle;
    readonly borrow: ImageUploadSessionBorrow;
    readonly url: string;
}
// On startUpload and resumeUpload callbacks, or UseImageUploadFlowOptions:
// onFileUploaded?: (completion: ImageUploadFileCompletion) => Promise<void>
interface ImageUploadAttachmentInput {
    readonly owner: ArticleAttachmentContextAdapter;
    readonly documentOwner: ArticleDocumentContextAdapter;
    readonly port: ArticleAttachmentTransactionPort;
    readonly anchor: ArticleAnchorContext;
    readonly origin: 'pick' | 'paste' | 'drop';
}
// StartUploadParams keeps files: File[] and accepts:
// attachmentInput?: ImageUploadAttachmentInput
// Existing externally admitted handles remain supported by the flow option:
// getAttemptBinding?: (file: File) => Omit<ImageUploadAttemptBinding, 'lease'> | null
```

Use the per-call callback when a flow also serves other upload entries. The
callback is awaited after the original raw complete acknowledgement and before
the next file starts. The flow releases that file's loan in `finally`. Batch
`onSuccess` does not carry live loans from earlier files. A later ordinary call
does not inherit a previous per-call completion callback.

| Input | Required original identity |
| --- | --- |
| File | Exact raw `File` object still held at the single original capture frontier. Preserve the reference before compression; compressed bytes/hash/length are separate runtime facts. |
| Batch/item | Original `batchId`, `itemId`, `order`, intent and signal from that capture. Equal metadata or matching identifier strings alone are insufficient. |
| Created handle | Genuine handle returned by the existing attachment owner's capture, not a clone or a second capture of an already captured editor batch. |
| Pending handle | Corresponding genuine result of that capture's original `commitCreated`, in the same file/item order. Keep exact object identity, request/signal and current source/map relation. |
| Owner/port/anchor | Existing canonical attachment/document owners and actual public transaction port, using the real current selection anchor and source map. No fabricated selection or map. |
| Lease | Exact lease from the flow's existing registry `beginTask`, after insertion changes the source revision. The flow injects it; the UI must not create another upload lease or clone a lease. |
| Generation | Private generation of the original runtime operation. Consumers do not supply, reconstruct or revive it. |

`attachmentInput` invokes the existing owner's capture/commitCreated once from
the raw File[] frontier and freezes each File/pending-handle association. It is
conditional on that frontier actually existing. For an already admitted pending
handle, use its original File association via `getAttemptBinding`; do not pass
`attachmentInput` and insert it again. Repeated references to the same File and
same-name Files are associated by original capture order, not names or URLs.

The current public MarkdownEditor source `0e5c56050e8dd3e9ca3735078489d35a0bb6e3d2`
does not supply that frontier to its `upload-image` consumer. Its private
`captureAttachmentFiles` maps raw File[] to metadata, dispatches insertion and
emits only `captured.batch` (markdown-editor.vue:2569–2611). `applyAttachmentResult`
is exposed; `captureAttachmentFiles` is not. Therefore an already emitted
metadata-only batch cannot be fed into this conditional API to recapture it.
The existing UI/capture owner must establish the original File-to-original-batch
association or identify a real newer public API. Do not construct Files from
names/metadata/URLs, call private editor methods, adopt fake handles, or treat
the source unit fixture as proof of the public input path.

The parent has assigned the sole public File bridge task against FsUSUI main
`8db0ac8f49749e3e5f28be5051bb3d3ed71ada71`; this task does not implement it or
claim its unprovided future API. A bridge must preserve original native File,
original batch/item and the single insertion transaction's pre/post revisions.
The Blog adapter's current `commitCreated` additionally requires membership in
its private captured-record WeakMap and dispatches that record's insertion
plan. An already committed public batch/transaction cannot be cast into a Blog
created or pending handle. The original capture/lifecycle owner must confirm
one genuine admission of that same batch/transaction, producing the original
pending handles. Do not perform another capture/insertion through the conditional
flow API or invent an adoption method that current source does not expose.

Each callback receives a fresh access object and its own signal. The object is
revoked and the signal aborted on callback settlement or its 30-second scope
expiry. Concurrent scopes are independent. While the original upload runs, the
loan still requires its actual owner, intent, lease and generation. Its
30-second completion window starts at the original successful acknowledgement,
so slow chunks do not exhaust that window. Release, raw upload failure, owner
cancellation, generation replacement and disposal revoke it. At most one loan
is issued per attempt; no expired/released/failed loan is reminted from public
session state or the original stored resume snapshot. Awaited work must honor
the callback signal; this API does not fabricate completion of a request that
ignores cancellation.

The five private fields come from the original fresh init, actual compression/
hash/size locals and actual complete invocation history. They are observations,
not AssetReference, rights, cleanup or document-commit permission. The completion
URL is only the existing display result. Unknown commit state retains the
original cleanup refusal and does not grant DELETE.

Writer branch `codex/chain-2246-preview-source-integration` was read at
`78d1f6d3be02a577e7d1fb6c68721a7f263788e6`; its Writer composable blob is
`a14cbc4726f04d9d2741792b278e81349ebee54a`. The canonical attachment/document/
anchor owner blobs match this runtime source exactly. No Writer source was
modified or consumed. The existing `observeOwnedImageUpload(handle, file, signal)`
already has an admitted single-file handle and an `outcome` local. Its owner can
move the current private observation from batch `onSuccess` to the per-call
`onFileUploaded`, requiring `completion.file === file` and
`completion.intent === handle`. Do not recapture that handle. No applied Writer
hunk or new host export is claimed here.

Inside that callback, explicitly project the five named fields into the existing
`createArticleAttachmentUploadProvider` input; it freezes a spread copy, while
private access fields are nonenumerable. Await its existing `observe(signal)`
within `withSession`; use the callback signal, not a retained global signal.
Do not return/persist the credential input or provider, or keep using a captured
access object after the callback. The original provider export is present on
the separately supplied provider branch and the current Writer source, not
added to this frozen runtime checkout. Actual business-authorized transactions
remain outside the private observation callback and with their original owner;
source mutation cancels the flow's original lease.

Original Writer unit totals and independent review are separate evidence. The
parent-reported269P/2F does not qualify the two legacy File[] fixtures or later
unmount refusal, and the independent reviewer's dynamic runs remain UNRUN.
