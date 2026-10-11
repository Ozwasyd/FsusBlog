# Historical source observation: actual persistent Writer owner boundary

Source observation and required producer facts only, not a new API/contract,
mount map or product acceptance. Related to #2246, #2250, #2243 and #2294.
Observed source: `3d6589208a1409fa806a06c99a14c0d04a6a5304`.
Layout owns Write.vue/component host/Teleport, task
`01a12bf3-5b8d-7153-be7b-e374d6ce1008`. This caller edits no Layout source.

## Available actual primary ports

The original `useAdminArticleWrite().authoringEditorRuntime.bindEditor` accepts
one real editor, original runtime options and a caller-held mounted reader.
It returns the actual binding, original release, search runtime, surface/preview
owner binders, mounted source and bindRecoveryCheckpoint. ArticleWriteEditor
exposes the actual authoring editor/session port through its original adapter.
Primary must reuse those held objects; it must not call acquire/bind again.

The mounted source reads the original registry association for a session ref,
compares the actual mounted object with that original editor and validates the
actual public session document/epoch/revision before and after callbacks.
It can represent only the actual current document owner. Keeping its actual
instance/handle mounted while hidden or moved preserves that instance. Neither
it nor a snapshot creates a second editor/document/form/draft owner.

## Concrete producer/lifecycle gaps

`ArticleDocumentContextAuthority` currently stores one adapter, not independent
per-session owners. Its acquire switches that same adapter for another article,
principal or site while prior component bindings still reference it. Adapter
construction issues a new opaque DocumentId; it does not acquire an already-held
registry/native document from a supplied session ref. Constructing a second
authority outside this owner or deriving IDs from refs would conceal the gap.

Writer articleId comes directly from the global route. Its watcher calls
switchDocument, clears form/draft state and starts initData. Unmount releases
runtime, document binding, tasks/observers and source state. Its form/draft/save
state and recovery operations are private to that original composable; no public
retained owner handle is issued to the canonical session host. New unsaved drafts
also share the existing create-draft key rather than a defined multi-draft issuer.
Two copies of the current composable would therefore share/switch the document
authority and global route while retaining separate form copies. Removing an
article-ID key or allowing a second editor binding cannot fix this ownership.

The actual producer boundary needed from the original document/session owner is
a session-ref-scoped retained handle to the original document/form/draft/tasks:
actual article/draft/document/epoch/source/draft revision and current scope;
context/content/loading/saving reads; native transaction/selection/focus/attachment
and original save commands; one initial editor bind and final close/evict/scope
release. Route selection must select that retained handle, without reacquiring it
or switching another document's state. A real secondary owner must already be
acquired through that original authority; registry refs or snapshots alone cannot
serve as its producer. A new body store, shadow map or whole Write copy is excluded.

The original owner must also supply the exact stable public editor/outline/textarea
ID parameters used for two real component instances. They cannot be guessed via
private DOM/class access. UI/FSUSUI acceptance stays with its original owner.

This is a missing producer/lifetime boundary, not a request for generic permission.
No new issue definition, schema, body/ref authority or fake interface was written.
No two-session capability or restore-ready result is asserted. The minimum ready
primary ports above remain usable; the second retained owner is blocked until the
original session/document lifetime API and actual owner inputs are provided.
