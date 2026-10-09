# Minimal Writer integration proposal — not applied

Owner2246 retains `useAdminArticleWrite.ts` blob e18a5c976d7bcee4a116bfe9505a725d5b251f9d. Actual source names already present: `articleDocumentContextAdapter` at848, `authoringAttachments` at861, `attachmentPort.binding` at894 and original `useImageUploadFlow` options at1085. Existing legacy file-to-URL path has no genuine per-file pending-handle association. That association must be supplied by Writer's existing real capture/commitCreated admission; no guessed function, recreated intent receipt or boolean-live surrogate is supplied here.

The minimal host options are `getAttemptBinding(file)` returning its actual `authoringAttachments`, `documentOwner: articleDocumentContextAdapter`, genuine original pending `intent` and current `getBinding: attachmentPort.binding`. The existing flow injects the exact original task lease; host must not create a second lease or upload. `onSessionReady(file, borrow)` captures only this short-lived memory handle in the corresponding original attempt context. It must not instantiate a provider from a premature false completion-history snapshot while the original runtime still owns compression/chunks/completion.

After the original runtime has completed and public activeSession is cleared, use the already acquired loan inside `withSession`. The existing provider constructor freezes a spread copy, while private loan fields are intentionally nonenumerable. Project the five named fields explicitly into its existing input only within the guarded callback; do not spread private access, persist the input, return a provider that escapes the callback, or infer any field from URLs/public session/localStorage. Await original operations and pass the callback's loan signal to every provider operation:

```ts
await borrow.withSession(async (facts, signal) => {
    const provider = createArticleAttachmentUploadProvider({
        uploadId: facts.uploadId,
        uploadToken: facts.uploadToken,
        sha256: facts.sha256,
        totalBytes: facts.totalBytes,
        commitMayHaveStarted: facts.commitMayHaveStarted
    });
    return await provider.observe(signal);
});
```

This fragment names the actual original provider export from the separate provider-facts branch and the actual new loan API; it is not an applied Writer hunk or a claim that the frozen branch contains that provider import. The corresponding transport/type-boundary prerequisite must also be consumed by exact identity. Actual document commit/reference/receipt/cleanup business contribution remains with its existing owners and must not turn observed facts into authority. Perform original document transaction outside the private observation callback; it invalidates original pending handle/lease. Cold stored resume, closed failed attempt and expired loans remain refusals with explicit recovery needs. Unknown commit cleanup is not a synthetic successful abort.

Future owner acceptance must execute its current original nonempty selection, genuine current per-file handles and context; cover release/caller cancel/unmount, actual endpoint ownership and late/unknown outcomes before product or receipt acceptance. The provided26 is ordinary runtime-module evidence only, not old Writer13/host40 or any producer's inherited control count.
