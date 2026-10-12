# Writer startup and loaded-primary handover: original-owner integration request

This is an artifact-only parameter/call-order handoff, not production application or a second implementation. Related to #2246, #2250 and #1809. All runtime/test/list/discovery/collection/import/mount/browser/native/full-ref acceptance remains HOLD/UNRUN. Parent supplied bounded independent SourceClosed evidence for the repaired Document offer and original caller; that does not close an execution issue.

## Exact inputs and unchanged custody

- Original caller checkpoint: `170e2af038cd3c35d275c62d7ce3a5a2e21a472a`, draft PR4153, branch `codex/chain-2246-preack-runtime-intake`.
- Repaired Document source: `26f5d8eb84b163e7b2cb4e94e3f829ec9b270f9e`; offer head `da0e8f0cd11ca2bfbe9d7e8e393c113717e8756e`, PR4228. Source is an ancestor of the supplied head. Actual Document blob `3d36ef1e420fc20ff5434a59cc3bb6fd1084dbeb` was read directly, together with its current boundary document and original preflight. Old `ad35a650...` is superseded and MUST NOT be consumed.
- Preserved Writer prototype: artifact commit `6bc45998309a8f5aaa742f00be35ca409a5725f6`, original Writer preimage `6c75ec510b9b19dda80eea292db6f6d7a7a092bf`, separate working candidate `41b4e7ab0f4d9a89afc72dd9b90bf144fde2a8e1`. Neither the working candidate nor the Document offer is applied by this handoff.
- Main `f3de` was reported independently closed by the parent. Its full commit identity/native/full-ref protocol was not supplied in this instruction; no abbreviated ref is fetched, guessed or consumed. Main's actual mounted draft-owner getter must survive its eventual exact composition.

Current #2250 body was reread: OPEN, unchanged prerequisites #2243/#2245/#2246/#1802, no comments. Its same-instance/history/epoch, no remount/body copy, no second continuity store, product-owner and FsusUI prohibitions remain intact.

## First prepared owner: exactly two startup parameters

The preserved prototype already defines this interface. It is WIP, not a newly shipped API:

```ts
export interface ArticleWriterPreparedStartup {
    readonly handle: RetainedArticleDocumentHandle;
    readonly preparation: ArticleDocumentRetainedPreparation;
}
// In the preserved prototype only:
useAdminArticleWrite(startup?: ArticleWriterPreparedStartup)
```

Main must supply the SAME genuine original authority preparation and original Registry handle before the first Writer construction. The preparation must have been issued by `prepareRetainedDocument` on the actual Registry with real scope readers; the original Registry owner must issue/admit its matching handle. No body DTO, document ID, epoch, revision, history flag or readiness boolean is a substitute startup argument. Do not issue another draft/document to make an old member fit.

The Writer acquires the actual retained binding before creating fixed document-dependent adapters/effects and attaches its original stable `createPrimaryConsumer` before its loaders start. Scope is read from the actual admin principal and canonical `primary-site`; prototype startup admits sourceRevision0/draftRevisionnull only. Main defers actual editor binding/mount until the read-only `preparedBodyLoaded` source-bootstrap signal is true and rejects `preparedBodyFailure`. That signal is NOT native/full-ref readiness. Passing a preparation for an already loaded Writer to a second composable is forbidden; the sole-primary guard and consumer ownership intentionally reject it.

## Loaded original primary: keep the original Writer, expose its private binding operation

The existing loaded Writer already owns its actual form, effects, adapter, primary binding and stable consumer factory. It therefore needs NO constructor startup/body payload and NO second `useAdminArticleWrite` call. Main must invoke the following genuine Document API from INSIDE that same original Writer closure:

```ts
const preparation = articleDocumentContextAuthority.preparePrimaryRetainedHandover(
    articleWorkspaceTabRouter.getRegistry(),
    handle,                       // the actual current Registry member handle
    articleDocumentContextBinding,// this Writer's still-live original primary binding
    {
        readPrincipalIdentityId: () => adminStore.adminPrincipal?.id?.trim() ?? null,
        readSiteScope: () => documentSiteScope
    }
);
const retained = articleDocumentContextAuthority.acquireRetainedDocument(handle, preparation);
const consumer = retained.attachConsumer(createPrimaryConsumer); // SAME original factory
```

These are real supplied Document API signatures, not a new public Writer method already present in production. For Main's exact implementation, the minimal Writer-facing extension can be an owner-local preparation operation taking only `handle`, and consumption on the existing `authoringRetainedPrimaryRuntime` taking that SAME `handle` plus `preparation`. The original closure supplies Registry, primary binding and live scope readers; do not export a mutable adapter or accept caller-created readers/context as authority. Main may implement these two operations under its existing protocol names rather than introducing a parallel owner.

Keep prepare and consume as distinct real phases if Main's native/full-ref protocol needs a refusal before Document publication. A genuinely unused, live preparation may be discarded by the original authority; published/retired preparations cannot be discarded to reopen admission or pretend rollback. The genuine preparation pins the previous context; intervening edits require refusal and actual unused discard/reprepare. Consumer attachment is idempotent only for the SAME original factory; an already retained consumer cannot transfer to another binding.

Admission requires same articleId, draftId, source body/digest and actual numeric sourceRevision/draftRevision; the official handover authenticates the target documentId/epoch from the genuine member. That authorized Document association alone does NOT establish physical native target identity/epoch/history or complete refs. Main must finish its actual native/full-ref protocol and verify those actual owners before readiness. Until that exact protocol is available, cross-identity/epoch/revision/full-ref restoration remains refused. Changing props to recreate/clear native history, changing metadata/digests or renumbering revisions is not an implementation of it.

## Writer loader/form: exact admission inputs and setter order

First-prepared-owner bootstrap selects only actual `getAdminArticleById(requestedId, buildSignalConfig(signal))` detail output or the actual empty new draft. No supplied DTO string, journal body or shared legacy create-draft key is body authority. The caller need not add another body-loader argument; its true request signal/invocation and the retained binding remain internal original Writer custody.

Before awaiting the actual detail request, pin these original facts, then recheck them after the await, before and after EACH original form setter, and before publishing source-loaded:

| Fact | Actual original value/reader |
| --- | --- |
| Lifetime/attempt | `active`, `writerScope.active`, `componentAttached`, actual `signal.aborted`, original current init invocation; no competing form restoration |
| Scope | original captured principal, live `adminStore.adminPrincipal`, canonical site/user scope; permanent `fullDraftPrincipalRetired` must stay false |
| Association | SAME `retainedPrimaryBinding`, genuine handle membership/state, registry revision, original editorSessionRef, `registryRevisionMatchesDocument`, no admission closure/invalidation failure |
| Document | actual adapter current context object, article/draft/document IDs, epoch, source/draft revisions and genuine content digest |
| Form/version | actual full semantic form, `currentRevisionId`, `currentRevisionNo`, `serverDraftRevision`, `activeRecoveryClientRevision`, actual draft key |
| Recovery | actual `serverDraftSyncPaused` and `draftConflictText`; preserve them, do not clear them to admit |
| Result | actual detail `data.id`, string `data.content`, genuine digest equality; actual response baseRevisionId/revisionNo, not inferred old refs |

Use original `applyDraftToForm(draft, { admit, preserveServerPause: true })`. `admit(expected)` compares to the expected PARTIALLY written form, not the original entire form after the first setter and not a freshly accepted watcher edit. Update the expected field before invoking each synchronous setter, check after it, and stop on supersession; do not overwrite newer edits or claim rollback. The prototype's eleven original writes are title, content, summary, cover, category, tags, status, schedule, rights, server revision, base revision. For the separate `currentRevisionNo` setter, update the expected revisionNo FIRST, invoke the setter, then run the same full admission guard. Preserve original suppression and cleanup on success/refusal/throw.

For the fresh-current-detail-only prototype, response base metadata is established by the actual admitted response and serverRevision remains null. This cannot accept an old unsaved draft/full-form checkpoint: that requires the original actual body/draft producer reference AND matching base/server/client/revisionNo custody. Equal body digest does not authorize those old values. If Main's path already loaded the SAME live Writer, preserve its established form/version/recovery facts and use the handover seam; do not rerun current-detail bootstrap over it.

Successful source bootstrap must NOT call `updateSource`/`updateDraftRevision` to manufacture prepared native revision, clear conflict/pause, flush journal recovery as authority, or publish retainedPrimaryReady. A no-change public transaction can verify actual bound native source/identity/revision after mount; it cannot transfer an old history/full-ref set. Original runtime/session object identity and Main's real draft-owner reader must be preserved.

## Smallest owner return and blocked boundaries

Main can return its exact full commit SHA, Writer startup/handover caller path, actual native acceptance/full-ref atomic publication API and preserved mounted draft-owner getter. Writer can then compare exact pre/postimages and continue its owned loader/form integration without whole-file overwrite or cross-chain conflict resolution. Native failure/interruption/repeat must keep original pending futures and cleanup custody and refuse ready; prompt cancellation receipts are not terminals.

No source implementation was changed or compiled in this artifact-only checkpoint. Prior static results remain bound to their original commits/blobs, not relabeled as this handoff. Current original caller170e and Mainf3de bounded source closure are accepted as supplied; they are not re-reviewed here. Runtime remains HOLD.

All assigned execution issues (#2246, #2250, #2253, #2256, #2280, #2282, #2284, #2286, #2287) remain OPEN/unaccepted; #1809 remains tracking-incomplete. This request does not weaken their acceptance, consume sibling work, merge, close, deploy, push master, or enter the final conflict-resolution phase.
