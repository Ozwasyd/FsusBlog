# Export production client — source WIP

Issue #2436 remains OPEN. Root owns GitHub content API writes and independent acceptance.
Branch: `codex/export-api-ui-2436-wire-integration-20261009`.
Usable lifecycle/API source: `5a4bc6a74b4ab5622d8b3c3bc19d842222539666`.

## Delivered source and ownership

The branch consumes the reviewed source merge `4937961e02ff587c2e13b8a463c9709ddfd82359`
through merge `8ae0f253f0c403cb657d026e132c17d8661165b5`. Existing registered consumer
and sole Shared codec/registry integration remain in its ancestry.

`92e3c58cf` consumes three exact, unmodified original #3653 files from
`935dc8871af2b89a97fa3b4214821f70f37ef0c3`:

- `src/frontend/src/services/documentExportPrivateDelivery.ts`
- `src/frontend/src/composition/documentExport.ts`
- `tests/frontend/unit/services/documentExportPrivateDelivery.test.ts`

The original saver receives actual validated `{bytes, filename, mediaType}` and
an abort signal, dispatches a temporary Blob download, removes its anchor and
revokes its local URL. Promise resolution denotes browser dispatch, not an OS
persistence receipt. The public composition function is
`createDocumentExportBrowserUiPort(options: Omit<DocumentExportWireUiOptions, 'deliverPrivate'>)`.
It uses the existing guarded client download API and the original saver. The
host still supplies actual authorized source choices, capabilities and admission
preparation; this wrapper alone does not activate a production export flow.

The lifecycle increment changes only these five API/UI-owned paths:

- `src/frontend/src/components/document-export/documentExportPrivateUiLifecycle.ts`
- `src/frontend/src/components/document-export/documentExportWireUiPort.ts`
- `src/frontend/src/components/document-export/documentExportUiPort.ts`
- `src/frontend/src/composables/useDocumentExport.ts`
- `tests/frontend/unit/composables/documentExportPrivateLifecycle.test.ts`

One transient view lease consumes the existing `privateRequestRuntime` admin
generation. Retirement synchronously aborts pending requests/downloads and clears
captured choices and callbacks. Microtask notifications clear the center's
snapshots/form state before paint, permit fresh host construction after the
original runtime's controller iteration, and honor unsubscribe during notification.
The host must provide a fresh authorized port on identity replacement; retired
choices cannot be reactivated. No shared runtime, API parser, durable job store,
source catalog persistence, response registry, route or DI file is changed here.

## Actual owner interfaces read

- Source catalog: `cb1a63028e5960e723f355f131e351f86bb6e475`.
  `IDocumentExportSourceCatalog.CaptureAsync(actor, sources, token)` and
  `CaptureRevisionsAsync(actor, articleId, token)` allocate durable source bindings.
  They are not zero-write GET operations. `ReadBoundAsync` rechecks the exact binding.
- Original session/composition: `935dc8871af2b89a97fa3b4214821f70f37ef0c3`.
  The real actor adapter and seven job routes exist in the owner's source.
  This consumer does not register them independently.
- Jobs: `4fd5c1bcb8726021f745e912dede743cf445dc1f`.
  Its Jobs contract files are already byte-identical on this branch; no second
  consumption or lifecycle implementation is required.

Neither read owner commit supplies an authenticated source-options AEDS response
root/client route. #3735 owns that schema/codec/frame/native/registry closure;
#3653 owns its HTTP/auth/PoW/DI/admission composition. The missing response blocks
production population of choices, not the completed independent client lifetime
and private-save work.

## Concrete Shared/host proposal — not an implemented contract

Please supply a generated typed projection with the following minimal shape.
Names below propose semantic types only; #3735 chooses canonical names, closed
fields/bounds and frame IDs. No frame number, parser or JSON fallback is added here.

```ts
interface SelectionResponse {
    sources: readonly {
        choiceId: string;
        label: string;
        coordinate: DocumentExportSource; // existing sole generated type
        private: boolean; // actual host policy projection
    }[]; // at most the actual catalog's 50-choice bound
    formats: readonly {
        formatId: string;
        label: string;
        providerId: string;
        available: boolean;
        reason: string;
        layoutProfiles: readonly string[];
        themeProfiles: readonly string[];
        support: readonly string[];
    }[];
    locale: string; // actual validated admission locale
}
interface SourceCapture {
    kind: DocumentExportSource['kind'];
    articleId: string;
    draftKey: string | null;
    revisionId: string | null;
    publicationId: string | null;
    // no sourceVersion: only the real durable catalog allocates it
}
// Expected client operations, once the owners publish their exact contracts:
captureSources(sources: readonly SourceCapture[], signal?: AbortSignal): Promise<SelectionResponse>;
captureRevisions(articleId: string, signal?: AbortSignal): Promise<SelectionResponse>;
```

All wire Int64s must remain canonical decimal strings; server mapping must enforce
its actual Int32 ArticleId bound. Source capture must preserve the original
`DocumentExportSourceRequest` coordinate grammar without reusing export admission's
already-bound SourceVersion requirement. Never serialize `DocumentExportBoundSource`,
fingerprint, draft/revision/publication entities, rights or responsibility data.

Format availability must combine `DocumentExportContractCatalog.Providers` with
actual admission capability; `ImplementationAvailable` alone cannot promise usable
output. Layout/theme values must come from `DocumentExportReadingStyleAuthority`;
labels/support/reasons and locale come from actual authoritative projections.
#3653 must define authenticated capture POST semantics, PoW requirements, uniform
denial and safe retry/uncertainty identity for these binding writes. A read-only
capability operation, if separated, must not secretly capture/persist sources.
The existing UI can map this typed response to its display-only choices and use
the original preparation adapter; it cannot populate them honestly beforehand.

## Focused verification and limits

- Official Node 24.16.0; actual local FsusUI
  `f2b3bb89ffe5f749da26c388f058efdbb6aee864` (1.5.1).
- Four relevant frontend files passed: private lifecycle 13 cases, original saver
  10, existing wire UI 9 and affected controller 57, total 89. After independent
  read-only review found notification unsubscribe ordering, the corrected lifecycle
  file alone passed all 14 cases. The combined positively selected case coverage is
  90; a single final 90-case aggregate run is not claimed.
- Canonical frontend style passed all six changed/consumed implementation files,
  eslint 6/stylelint 0; the corrected lifecycle file separately passed again.
  Test files are outside that implementation checker scope.
- Full canonical application typecheck remains FAILED: 202 diagnostic lines on
  both exact pre-increment `8ae0f253f` and this source, after normalizing only relative
  paths to the same FsusUI checkout. Introduced 0, resolved 0, export scope 0.
- Real Chromium desktop 1366x900/light and mobile 390x844/dark/reduced-motion used
  the literal queued owner golden (output null) in the real center. Original admin
  revocation clears choices, form and task detail; focus returns to the task heading.
  No horizontal overflow, page errors or Export POSTs. Actual screenshots inspected.
- Both browser contexts actually saved a separate three-byte Blob fixture and its
  exact filename `verified.html`; actual artifacts were read and compared to
  `[3, 5, 7]`, SHA256 `ed6fb2f856b776448d65399117a452d705445d7da76ffaff7663d76a7fc1b6a4`.
  Private URL count returns to zero. This tests the original saver, not an export
  provider output, authenticated grant, successful job or receipt.
- Two browser probe attempts failed because of test locators (task ID is not in
  the table; source label matches input and listbox). Their local logs are retained;
  corrected actual-control locators passed. Product code was not changed for these.

Relevant unit invocation from `src/frontend` uses actual `vitest.config.ts` and
`FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI` with exactly
`documentExportPrivateLifecycle.test.ts`, `documentExportPrivateDelivery.test.ts`,
`documentExportWireUi.test.ts`, and `useDocumentExport.test.ts` at their paths above.
The final correction runs only the first file. Canonical type command is
`node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application`.

Authenticated server/source/PoW/freezer integration, actual provider output and
receipts, real grant delivery and OS persistence remain unverified. Original
#3653 owns navigation/routes/DI. Independent acceptance remains required; full
application types remain red. This task did not dispatch remote CI, deploy,
publish packages, merge this production branch or weaken any guard.
