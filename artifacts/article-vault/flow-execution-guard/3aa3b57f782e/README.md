# Original Flow execution context guard — partial progress

Tested source:3aa3b57f782e2ebd4d898ab7e6a3d68ece72da79.
Tree:96e10c9bc5bf430c01098ade86c1d7e517a57566.
Base:0c1576c37d75e69e2b6425e245fd3f47eee25367; fetched master9d72a1c93b297f719d8695a642cdfb1615cf1d51.
Same branch codex/chain-1975-runtime-attempt-borrow and draft PR4151.
Qualification=false. This is a local execution guard, not completion of the requested recovery handoff.

## Implemented and held objects

The original Flow instance holds its actual pendingContext: original File objects,
callbacks and genuine original intent bindings. A private shallow reference identifies
one still-awaited start/resume execution. While it remains pending (including logical
cancellation), duplicate start/resume and clearPending refuse to replace that context.
The same guard respects existing runtime cleanupRequired. canResume is false and
onError reports local admission conflict. The marker is local exclusion only: ending
an execution clears its marker, never acknowledges canonical receiving or release.
Only Flow, its existing test file and the current architecture overview changed.
Runtime, Writer, cleanup business, Shared DI, transport, public interfaces, SDK/cache,
existing139 test contents and original owners remain unchanged.

## Exact remaining blocker and proposal

The actual original chain still awaits onFileUploaded AFTER uploadFile returns.
The raw runtime catch only retains ACK/snapshot/error BEFORE transportCompleted.
Thus a late consumer error/cancel can still escape the original recovery boundary.
Nine targeted original-runner probes reproduce this gap at0c1576: corrected probe9FAIL,
zero passed,123 runtime cases outside selector. They cover original File/intent/borrow,
ACK/snapshot/error, cancellation/late resolution or rejection, dispose, repeat/replace,
loan deadline, original token persistence and public-state mutation. These probes are
preserved under pending-interface and are NOT enabled as green candidate tests.
Initial9FAIL used an incorrect Storage.prototype observation in one probe; corrected
observation uses the real original window.localStorage owner, retaining the assertion.
Both reports are retained, without admitting that initial observation as valid proof.

Parent explicitly requires a decision BEFORE any new public interface. Pending proposal:
`onSessionReady?: (borrow: ImageUploadSessionBorrow, completionUrl: string) => void | Promise<void>`.
Only runtime would supply completionUrl from its real correlated complete ACK; original
Flow would compose and await the original consumer inside this existing callback,
retaining its actual File/intent/borrow and validated URL. This URL is an observation,
not business authority. Proposed transition: actual ACK -> original awaited consumer ->
normal fulfilled transport completion OR original generation-bound recovery-required
ACK/snapshot/error with zero abort and blocked reupload/recomplete. Callback cancellation,
old generation and delayed results must fail closed. No caller verified flag, synthetic
ACK, new loan or ledger, new token persistence or cleanup action is permitted.
The extension and core transition have NOT been implemented; no approval received.
A genuine browser canonical receiver interface/current business receipt is still absent.
Even after local failure retention, no ordinary void callback or local boolean can
acknowledge business receiving/release. PR4170 server cleanup is not that receiver.

## Current author verification and history

Original preflight, style, current commit-range,37 prerequisite controls PASS0 on the
frozen published source. Actual official discovery140 unique names:124 runtime+16API.
Complete140 PASS0/zero failed/skip; all original139 names and test contents retained.
Original2 positives PASS (122 runtime outside selector). The prior original45 controls
pass within140; their earlier before-fix receipts remain unchanged and are not relabeled
as rerun here. One new execution guard control fails on exact0c1576 source and passes
on the current candidate, preserving original hooks/config/imports and input identities.
Original hooks have matching start/finish identities; observed workers exited.
Full application types remain FAIL exit2 current/base,244/244 zero added/removed.
Full inherited old Refs footer still FAIL, not waived. Independent new-guard review UNRUN;
prior independent c93 bounded139/45PASS remains tied to its original source.

Initial style failed import ordering; initial candidate had246/244 types (two nullable
setter errors), then an explicit ShallowRef annotation repaired the added diagnostics.
A local unpublished style metadata attempt failed the Change-Class contract; its import
repair was consolidated with the actual type fix in a normal fix commit. Published0c1576
history was not rewritten or force-pushed; exact original records/SHAs are preserved.
Initial/current/intermediate PASS receipts are not transplanted to final source. Final
checks were rerun on3aa3b57. First setup refused empty leftover source node_modules;
only task-owned links/empty directories were cleaned and the unchanged canonical helper
then succeeded. Shared locked cache was preserved, with identical actual Vue graph.

Commands, exact HEADs, UTC times, exits and run identities are under records; logs are
byte-exact gzip, actual reports/topology/preflight-produced output and pre/post source
images/patch are included. Own27 links, negative worktree and tmp were removed. Full16
owned issue statuses are in issue-status.md. #1975/#1976 and all held server/native/
product/browser/security/custody/migration/backup/restore/QA gates remain open/paused.
No integration of Writer4153, cleanup4170 or Shared4155; no new DI/transport activation,
production action, issue close, PR merge/auto-merge, package publication or deployment.
