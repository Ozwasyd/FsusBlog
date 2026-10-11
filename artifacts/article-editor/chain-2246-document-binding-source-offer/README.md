# Historical source offer: Document binding gap and borrowed native capture

Status: source WIP and coordination evidence, not an authority contract or an
acceptance receipt. Related to #2246, #2250, #1809, #1814, #1908 and #2275.

Source increment: `4d3ee43721b2fae113ffb86338e85a951335138c`, parent
`8f3811352120d907fd4cd88eb465284ed2de415e`, tree
`05d73c971441323ddd0c54bfeb53e983494f4f81`.
Branch: `codex/chain-2246-preack-runtime-intake`; existing draft PR4153.
Observed latest origin/master: `9d72a1c93b297f719d8695a642cdfb1615cf1d51`.
Master and the supplied fragment commits were read, not incorporated.

## Existing server identity gap

The current #2243 contract and `ArticleDocumentContextAuthority.acquire` own a
local opaque DocumentId, document epoch, source/draft revision and editor-session
continuity. `nextOpaqueDocumentId` allocates a process sequence. This identity is
not a server grant. #1814 is a product tracking owner, not a server issuer.

`AuthoringRevisionCompareDraftContextProvider.ReadAsync` does enforce the current
principal's persisted draft ownership and the exact `primary` site. Its context
contains article, draft key, persisted server revision, rights digest and a
derived `draft-epoch-v1` snapshot identity. It contains no DocumentId. The snapshot
epoch changes with content/revision and is not #2243's editor document epoch.
The Writer uses `primary-site`; no formal mapping between these coordinates or
DocumentId issuance/binding was found in the inspected API contracts.

The actual authoring draft POST/GET route uses the current session principal and
ArticleWrite permission. `AuthoringDtos`, `ServerDraftResponse`, the route catalog
and `IAuthoringDraftLifecycle` expose no Document acquire/bind/verify operation or
server-issued DocumentId. `ArticleDraft.Id` is a persisted row coordinate, not an
already defined DocumentId. These guards remain mandatory; client DocumentId,
digest, CanvasId, layout reference or derived epoch cannot replace them.

The extension host has `IAuthoringDocumentRevisionGate` and
`IAuthoringCanonicalDocumentReadTransaction` interfaces. They require canonical
observations and independent grant checks. No production implementation or
registration of those document ports was found in the inspected backend source,
including latest master. Their existence does not supply an issuer or public API.

The same provider, draft DTO and frontend draft API blobs are unchanged between
the offered base and observed master. The local Document owner and draft service
have master deltas, but none supplies the missing binding. Master's draft service
normalizes content; this branch's exact source-byte admission was retained.

The supplied fragment branch at `d21c9328` additionally has real binary compare
and draft-coordinate routes. The latter reads the session principal and exact
authorized article/draft/revision, invokes the same context authority and returns
draft key, article, server revision, derived epoch and source digest. Its provider
adds exact draft-key checks. It still issues no DocumentId or canonical binding to
the Writer document identity. That API and its permission/package acceptance stay
with the original #2268/#2275 owner; the donor source was inspected, not consumed.

Before a backend binding implementation, the existing product Document owner and
canonical draft/backend owner must define whether the local editor identity is a
session correlation bound to an authorized draft or a server-issued Document
identity. They must also specify unsaved/create-draft binding, canonical site
coordinate, issuance/read admission, lifetime and invalidation across article,
draft, session and revision changes. The current issues do not define those
semantics or an issuer. No new server registry, database field, wire frame,
client-ID authorization path or fake verifier was added here.

Existing ownership to preserve: #2243/#1809 own the local context; #1814 aggregates
product surfaces; `IAuthoringDraftLifecycle` owns persisted draft access and the
existing writer; #2268/#1811 own revision compare package/context validation;
#1908 owns Inbox lifecycle composition. The coordinator must route the missing
server contract to those existing owners. #3735's Canvas authority is not the
Article Document identity owner and its files were not modified.

## Caller-held fragment preparation interface

The supplied fragment source is
`d21c9328703c2387c33f7b8e672316734aa45269`; its final handoff is
`10ce06e610c048bcbd3657043f46f3dc73c56e28`. The fragment owner retains proposal
validation, permission/package rechecks, execution and duplicate rejection.
Neither commit was merged or cherry-picked here.

`authoringEditorRuntime.bindEditor(...).binding` already returns the actual
`ArticleEditorRuntimeBinding`. The increment adds
`binding.borrowCompareTask(producerRef, readCaptureOptions, producerVersion?)`.
It returns the existing owner's compare task, `captureCurrent()` and idempotent
`release()`. Keep the actual binding together with that loan. The loan conveys
native capture and cancellation, not an action grant or transaction receipt.

`captureCurrent()` calls the existing continuity owner using current FsusUI maps
and its observed native selection. It preserves direction/history/context and
fails when no native observation exists. It checks the borrowed task before and
after the host options callback and after capture. No historical byte offsets,
DOM parser, fallback selection or second continuity store is introduced.

Source/draft changes, document switches, repeated producer tasks and editor
disposal cancel or invalidate the loan through the original task owner. Abort
cleanup does not recursively cancel an already aborted task or replace its
original reason. Capture after cancellation/release is refused. The existing
`binding.dispatchTransaction(context, transaction)` remains the only dispatch
consumer; this increment adds no dispatcher or fragment action.

The downstream caller can adapt the existing capture shape as follows:

```ts
const binding = bound.binding;
const caller = binding.borrowCompareTask('revision-fragment:prepare', readCaptureOptions);
try {
    const readCurrent = () => {
        const captured = caller.captureCurrent();
        return {
            document: captured.document,
            selection: {
                start: captured.anchor.range.start,
                end: captured.anchor.range.end,
                direction: captured.anchor.direction
            }
        };
    };
    // The #2275 owner passes readCurrent and caller.task.signal to its proposal
    // preparation. Permission/package/fragment rechecks remain with that owner.
} finally {
    caller.release();
}
```

`readCaptureOptions` must come from the host's actual current surface/tool/viewport
owner. This recipe is not an executed consumer. No fragment intake currently
calls this interface, and the full Write composition still lacks a qualified
current viewport capture callback. Attachment capture's existing zero offsets
are not substituted. The coordinator can offer this source interface to #2275;
the remaining host callback and authority join are explicit integration gates.

## Verification and retained limits

At source `4d3ee437`, TypeScript 6.0.3 syntax inspection under official Node24.16
reports zero parse diagnostics in the two changed files. `git diff --check` exits
0. These are syntax/whitespace observations, not types, lint, unit, native or
runtime acceptance. Eight newly written ordinary regression controls remain
NOT RUN; no runner listing was requested or executed. They cover fresh backward
selection, missing observation, repeated loan/release, native source change,
draft callback reentry, same-byte article switch, late reads after release and
disposal during capture. Their fixture uses real public editor calls with
controlled host capture options; it does not qualify a real viewport or full page.

The coordinator's preflight barrier retains tests/test listing and all native,
security, database, receipt, server/browser, UX, performance and accessibility
qualification. No held gate, package publication, deployment, merge or issue
closure occurred. The previous exact8f38 independent 377 PASS belongs only to
that older source. Its types227, style82,700 and import5 FAIL remain retained
history, not new-source results. Fragment owner's 32 UNRUN/30 types FAIL also
remain separate historical evidence.

All ten original assigned issues remain OPEN/unaccepted:

| Issue | Source progress and remaining acceptance gate |
| --- | --- |
| #2246 | Existing public-map/anchor consumer; this increment borrows native context. Real anchor/scroll/native boundary acceptance remains open. |
| #2250 | Existing continuity owner plus caller cancellation/release source. #2245 evidence, host capture and transition/runtime acceptance remain open. |
| #2253 | Existing continuity regressions; eight additions are NOT RUN. Full large-document/epoch/restoration acceptance remains open. |
| #2256 | Existing attachment adapter and bounded8f38 corrections. Genuine flow recovery handoff and native/business acceptance remain open. |
| #2280 | Existing surface/preference source. Migration and product surface acceptance remain open. |
| #2282 | Existing capability/fallback source. #2245 evidence and Live session/runtime acceptance remain open. |
| #2284 | Existing compare/tool source and borrowed capture interface. Actual host callback, #2245 and compare/runtime acceptance remain open. |
| #2286 | Existing independent preference source. Current user-scoped preference acceptance remains open. |
| #2287 | Existing Focus/Typewriter source. Public native contracts and runtime acceptance remain open. |
| #1809 | Tracking only: aggregate child evidence; no standalone implementation or closure. |

The external prerequisite remains #2245: its sole owning root must supply the
exact accepted commit, branch and current acceptance evidence. Preserve91 pending,
79 null and `fullGeometryVerified=false`. The new source interface and the server
design-gap report do not complete this chain or accept Inbox/fragment work.
