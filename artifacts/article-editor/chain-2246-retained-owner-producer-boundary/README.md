# Retained Writer producer: existing facts, minimum gaps and callers

Related to #2246, #2250, #2243 and #2294. Read-only source/lifetime observation,
not an API declaration, new binding/token issuer, acceptance receipt or proposed
replacement owner. Observed Writer source de6df11110b5d060a001fad36bb604627323e32a;
origin/master9d72 verified again. source-observation.json binds every observed file.

## #2245 scope clarification

Parent confirms #2245 owns identity-bound last-valid render/cache and cancellable
refresh. Its source is already consumed by the existing Writer history; issue WIP
is an acceptance gate, not a reason to recreate that implementation or block
independent Writer source. Parent supplied original render owner head
9b4d90773384373e005e788e76184bb10b5823dc: fetched/read only, not merged or applied.
Its original cache/context/runtime files differ from Writer's later owned fixes;
there is no instruction to overwrite those fixes. It supplies no accepted evidence
or new document/draft/session issuer. Latest parent acceptance remains WIP.

## Existing original capabilities

ArticleDocumentContextAuthority already issues an opaque draftId for create,
editorSessionId, and its adapter issues an opaque documentId. Adapter owns epochs,
source/draft revisions, scope and task cancellation. This issuer remains sole owner;
no new ID generator or external shadow authority is needed. Earlier wording about
missing new-unsaved-draft identity means missing retained/multiple-draft lifetime
and persistence semantics, not absence of an existing opaque draftId issuer.

The actual ArticleDocumentContextBinding exposes adapter/switchDocument/release.
Authority.acquire accepts articleId/siteScope/userScope/content, stores one adapter,
and switches that same adapter for another article/scope while bindings still exist.
It has no acquire-by-held-editorSessionRef or retained original owner enumeration.
Its editorSessionId is not automatically the registry's editorSessionRef: the latter
is supplied to canonical open commands and separately observed on the native session.
No caller may infer their issuance relationship from similar strings or route values.

Writer currently returns its actual articleForm, pageLoading, submitting, context,
identity, adapter, attachment/editor runtimes and save/submit/recovery commands.
The original bindEditor result supplies binding/release/mountedSource, preview and
surface binders, and the actual extended journal checkpoint port. These primary
objects should be reused once held, not acquired again for each placement. Native
snapshot/body and File loan joins at1400 remain usable source and are unchanged.

## Minimum retained producer inputs and missing operations

These rows are facts an actual original producer must supply. Method names are
Layout's requested facade vocabulary and are NOT implemented/existing APIs here.

| Required fact/operation | Existing fact to reuse | Exact missing retained semantics | Legal owner/caller |
| --- | --- | --- | --- |
| Original owner handle and membership/current read | Genuine acquired document binding plus actual original form/runtime owners | Enumerate already-retained original objects; reject released/replaced/scope-stale handles without reconstructing them from refs or snapshots. listRetainedBindings/isCurrentBinding need that producer. | #2243 document/draft issuer with canonical session lifetime owner; Layout only borrows the resulting facade. |
| Document/native/registry association | Original articleId/draftId/documentId/epoch, editorSessionId, source/draft revisions and site/user scope; canonical entry's tabId/editorSessionRef/lifecycleRevision; actual mounted native object/session | Producer must connect those genuine owners and return current reads. A registry entry has no form/native issuer. An arbitrary getSession(ref), echo of entry data or second authority is insufficient. | Original document/session producer; existing mounted resolver validates borrowed association and never issues it. |
| readView and body/form setter | Same original articleForm.content, pageLoading and submitting refs; context getter and original mutation pipeline | Select that original retained owner. A setter must target its actual form/revisions/tasks after current/scope validation, without copying body into a second store or selecting a different route-owned form. | Writer original owner supplies bound read/mutation; Layout/component host reads and invokes it only for the same genuine handle. |
| Transaction/selection/focus/attachment/save/submit | Existing runtime.binding consume methods, original File/capture admission and pending handles, original saveDraftNow/submitForm and task owners | Every event/command must use the same retained handle, not whichever route is currently selected. Save/submit must retain real server/base/client/principal scope and existing permissions/PoW checks. | Existing Writer/editor/attachment/save owners; host dispatches bound callbacks and cannot manufacture pending handles or business grants. |
| Draft/recovery persistence coordinates | Existing opaque create draftId; original draftKey, browser recovery tabId, base/server/client revisions and journal binding | CREATE_DRAFT_KEY is one literal key for current create Writer; current recovery coordinates also come from this component. Producer must define preservation/selection and persistence semantics for simultaneous drafts using original owners. No caller-generated draft or storage namespace is authorized by this observation. | Original #2243 document/draft and original recovery/storage owners. Journal validates supplied original facts; it issues only checkpoint custody/ref, not drafts/sessions. |
| bindMountedEditor and retained lifetime | Primary's already-held bindEditor result; original native editor/session and mountedSource | Bind once to the real owner, reuse primary, retain original Vue effects/tasks/form while hidden or moved; route selects an already-held owner instead of switchDocument/reset/initData. Final close/evict/scope must release original resources through actual authority after required gates. | Writer original mount owner binds; canonical session composition/close/evict/scope owners control lifetime; Layout moves the single VNode and cannot release merely on placement change. |
| Public DOM identifiers | ArticleWriteEditor textareaId/labelledBy/outlinePanelId/outlineTitleId; outline Vue useId | Already available. Host supplies stable unique secondary textarea/label IDs for a real second component; these strings are not document/session authority. | Original components provide public parameters; Layout host supplies actual accessibility IDs. |

## Lifetime calls cannot be inferred from registry presence

Writer watch(articleId) currently switches the original adapter, resets form/draft
state and starts initData. onUnmounted releases recovery/runtime/context/task and
attachment owners and clears body. Vue component effects also end on unmount.
A persistent native VNode by itself does not retain the original form/effect lifetime
across those operations. Two copies of the current composable would share/switch
the single adapter while holding separate route-owned forms; this is not a retained
second document owner and is prohibited.

The original router requestClose intentionally does not detach: confirmation and
recently-closed ownership are separate. Registry detach-on-final-close requires its
original close decision. AuthoringSessionHost.applyCloseAuthority and eviction
capture/pause/dispose use real session lifecycle authority and complete snapshots;
currently the original factory refuses the missing aggregate before capture.
No fabricated close ref, forced disposal, silent eviction, loosened snapshot gate
or blanket release on tab activation may replace that pipeline. Principal/site
scope invalidation must also reach original Writer/attachment/journal/task owners.

## Ready handoff and smallest next source input

Parent is obtaining #2243's exact original producer source/API. The minimum useful
handoff is its genuine retained handle acquisition/read/lifetime signature and how
it supplies actual canonical editorSessionRef/native association plus original
draft/form/recovery owner; include close/evict/scope call sites and create-draft
persistence semantics. Writer can then expose the requested facade from those
actual inputs, bind the held primary once, and preserve original transactions and
commands. A TypeScript interface without those actual objects/call sites would not
satisfy this dependency. No whole-chain #2245 wait is required for this source work.

All ten assigned issue statuses remain as recorded in the native-source-join README:
execution unaccepted, #1809 tracking-only/incomplete. This observation runs no tests,
list/collection/mount/native/backend/product checks, creates no owner/storage map,
changes no production/Write/Layout/authority code and refreshes no frozen receipt.
