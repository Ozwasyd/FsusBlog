# Finite completion loan — ordinary source verification

Original runtime scope only. Before actual successful complete acknowledgement,
compression/hash/init/status/part/complete work retains operation-owned state and
cannot grant a session loan. The completion callback is invoked only after that
acknowledgement and original generation/owner/intent/lease validation, while the
original operation remains active, before clearing the public session/snapshot.
The first actual acquisition starts one finite 30-second deadline. Neither a new
withSession invocation, release, expiry, snapshot, public state nor an inactive
operation can refresh or remint it. Each access scope retains its own revocation
and callback signal. Callback failure, owner cancellation and disposal revoke
access; true completion/unknown commit history and original cleanup refusal remain.

Public ImageUploadAttemptBinding/SessionAccess/SessionBorrow signatures and the
original per-call flow API are unchanged. onSessionReady timing is now completion
only. Parent-supplied Writer78d/a14 source only saves that handle in onSessionReady;
no precompletion read requirement was found. Writer was not edited or consumed.
Flow still awaits onFileUploaded({file,intent,borrow,url}) per exact original File
and pending handle before moving to the next file, and releases the loan. Optional
attachmentInput is valid only at the original raw File[] capture frontier. It
cannot adopt an already-dispatched public batch by recapture, casting, fabricated
handle or private WeakMap insertion. The public File bridge and zero-dispatch
admission remain their assigned owners' work.

The original network API calls accept optional signals, but the current runtime's
initUploadSession/uploadPart/completeUpload/abortUpload calls do not pass owner
cancellation signals. Compression/hash and callbacks that ignore cancellation
can remain physically pending. No operation-wide RPC timeout exists. These are
original operation/API policy gaps, not new loan authority; this repair invents
no network timeout or second cancellation policy. Existing abandon after known
completion can still request the original abort endpoint while public cleanup
has not finished; the ordinary mocked acknowledgement is not a qualified
committed-asset cleanup outcome. Current HTTP/rights/reference/reuse/recovery
acceptance remains open under #2258 and the original upload/ledger owners.

All results here are ordinary HappyDOM/source-unit checks. Original locale/global,
AEDS, compression/hash and API mocks are preserved; editor/authoring/registry
owners use genuine FsusUI0e5 source. No native build, browser/HTTP, product SDK,
receipt/custody/cohort/race/security, migration or backup qualification was run.
Node24.16.0 is the official task-local binary in environment.json. Test command
records and actual discovery/report/topology files define names, counts, exits,
source/run identities and worker teardown. Baseline full types and full published
commit-format failures remain failures. Earlier 9461 2/36/37 and its later
reviewer results are historical, not current acceptance of loan semantics.

New independent verification must be requested by the coordinating parent through
review thread 01a1219d-1a8a-7640-be37-1002c0f51014 against this exact tested source.
It is not claimed run here. Roll back this ordinary source integration if a current
regression appears before downstream adoption; no database rollback is implied.
No Writer/File bridge/adapter/lease-policy edit, issue/PR write, package publish,
held qualification, deployment, production DB action, merge or issue closure.

Tested source: `b8723dc2baedef4c6adccbdd7cc88cae38494176`. Published branch: `codex/chain-1975-runtime-attempt-borrow`.
Latest fetched origin/master: `9d72a1c93b297f719d8695a642cdfb1615cf1d51`.

| Actual final check | Result |
| --- | --- |
| Official Node24.16 mandatory preflight | PASS exit0, current clean source |
| Exact discovery | 41 real cases, exact positive selector2 |
| Original positive selection | PASS2;39 outside selector |
| Original focused file | PASS41, failed0/skip0;41 matching starts/finishes; workers gone |
| Original ordinary prerequisite controls | PASS37, failed/skipped/cancelled/todo0 |
| Original11 complete calls and hooks | Byte-identical to04195, TypeScript6.0.3 AST |
| Two original composable source-style checks | PASS0 violations |
| Full application types | FAIL exit2, baseline244/current244, added0/removed0 |
| New commit range8351..b872 | PASS |
| Whole published history04195..b872 | FAIL1, old9def missing Refs footer, no rewrite |

Raw commands, exits, source/run identities, reports and topology are included.
`tested-a6fad0a/` preserves the earlier tested40 source and its exact receipts;
`intermediate-preflight*` is not current clean-candidate acceptance.
Prior rejected9461 lifetime semantics, its35P/1F failed run and subsequent2/36/37
results remain in [the immutable historical artifact](../../runtime-review-repair/9461d18fb5fd/README.md).
All 16 accepted issues remain OPEN; see [issue-status.md](issue-status.md).
