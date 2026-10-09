# Owned intent business reader integration

The isolated consumer branch is `codex/chain-1975-owned-intent-business-reader`, based on the exact supplied reader `37143050f01346bde533686e383ba93f0dd053d8` / `codex/chain-2246-attachment-authority-reader`. Its dependency ref is read-only. No source from the preview host `5a6e895a1468b3640a3bd25391d0404803e2bd57` is changed or copied here.

Minimal owned file: `src/frontend/src/services/authoring/articleAttachmentBusinessIntentReader.ts`. It borrows the original host handle lookup and live context/public map, then calls the original WeakMap/lease reader twice across the promise boundary. It stores no intents or receipts. Its verifyIntent function structurally supplies the existing `AttachmentBusinessAuthority.verifyIntent` port from the original8ff business module. readOwnedIntent returns original false/null observations without turning unknown into deletion or a grant.

The original host composes the new reader with its existing handles and binding, preserving callback receivers through the original closures:

```typescript
const intent = createArticleAttachmentBusinessIntentReader({
    attachments: originalAttachmentAdapter,
    handle: intentRef => readOriginalHostHandle(intentRef),
    binding: () => readOriginalCurrentPositionBinding()
});
// Existing business authority consumes intent.verifyIntent. Its original
// observeReference/observeCleanup callbacks remain separate original owners.
```

Those callback names describe the original host inputs; they are not new exported host APIs. Host wiring belongs to2246/its canonical writer owner and is not edited here. Lifecycle log snapshots and reconstructed handles are refused by the actual original reader. The business node is only coordinates; it never serves as the handle capability. Completed handles are checked against original completed lease/current revision even if their original signal is already aborted.

The remaining reference business adapter can be isolated by root in `src/frontend/src/services/authoring/articleAttachmentBusinessReferenceReader.ts`, alongside its ordinary selected tests. It should receive the original authorized resource/reference callback and the current owned intent input; invoke only that original authority, recheck intent/context/asset version/ledger before returning its actual receipt, and preserve unconfirmed when it is absent. Do not derive receiptRef from the3a supplier facts or use a cloned intent/lifecycle record as authority. The exact live transport/receipt-producing method is not supplied by3a and remains with the original ledger/resource/3735 owners; this boundary must not invent a route, frame or operation grant.

Cleanup worker already consumes the original3a scheduling forwarder. It retains original transaction and seed1779 asset lock,24h/one queue policy and real post-commit queue/state observation. This consumer neither replaces that worker nor promotes SchedulingRequired/Task success to a durable receipt.

Tests belong to `tests/frontend/unit/authoring/articleAttachmentBusinessIntentReader.test.ts`:21 ordinary controls with actual original FsusUI dispatch/position map. They require separate nonempty positive admission and exact locked dependency restore before execution. Supplied35 adapter/37 host results are not inherited. No held security/receipt/integrity tests or product/browser qualification are included. Test results will be recorded only against the actual tested source, not inferred from this source delivery.

The backend source-bound handoff and complete draft PR body are already published on `codex/chain-1975-current-draft-integration` at `69477c07466ff159e35b26d469dcdd2fefc13601`, under `artifacts/article-vault/current-input-binding/3a4729cc2c8b/`. Its8/89 tests remain bound3a; it is not this reader's receipt. All16 issue terminal qualifications remain open as recorded there. No GitHub content API write, issue close, merge or runtime activation occurs here.

Current validation: TypeScript6.0.3 parses both own files with0 syntax diagnostics; commit-range/diff checks pass. Canonical typed lint is blocked on the missing original Vue tsconfig after full locked restoration fails. The official offline restore returned ENOTCACHED for private @ozwasyd/element-plus1.5.1; the normal original-registry restore returned E401 Unauthorized. That package operation is stopped, with no alternate identity/endpoint retry. Positive discovery/admission and21 controls are NOT RUN; no runtime or qualification claim. Coordinator must restore task package-read access or exact original-lock-integrity cache, then rerun the actual locked project and the selected positive gate. Detailed source/hash/commands/blocked status is retained in handoff.json and exact CLI logs.
