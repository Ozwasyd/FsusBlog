# Historical source correction: Writer checkpoint reentry and release

Coordination/source evidence only. Related to #2246, #2250, #1813 and #2294.
Actual source/control commit: `3d6589208a1409fa806a06c99a14c0d04a6a5304`.
Implementation commit: `32ba255c6`; actual source blobs are in static-results.json.
Original upload intake d27ed27e remains applied; all15 postimages and retained
protocol, save, journal and frozen-authority boundaries remain unchanged.

Independent reviewer found a real P2 at dc98: the initial mounted reader could
reenter before the checkpoint slot was filled, issue an inner journal binding,
then have the outer port replace its slot. The inner release would return without
releasing its custody/listeners. This source fixes both halves of that defect.

Creation is now reserved before the first external mounted read. Every partial
creation has its own idempotent cleanup, which releases the issued original
journal binding and both listeners even if the slot no longer refers to that
port. Failure reclaims the reservation. A final owner read after allocation/
subscription refuses synchronous runtime release or replacement. The returned
port retains original async prepare/restore and sync inspect/validate semantics;
no token-to-string, new journal/store or factory qualification was introduced.

Three source controls were added to the existing real Writer/native editor/
registry lifecycle file: first-reader reentry, failed-reader retry plus successor
protection, and subscription failure after actual journal allocation. They
delegate to the real original journal binding, instrument its release only and
fabricate no token or persistence receipt. All are NOT RUN; test-list/discovery,
matrix and frozen qualification producers were not changed or executed.

Before the actual source check, all727 frontend source postimages matched the
actual main branch byte-for-byte. Original application type entry with old actual
journal, public UI06d and canonical699 config overlays: exit2/234 diagnostics,
no added/removed normalized diagnostic against d27. Actual main still lacks the
two journal exports and bindCheckpointSource, with four cascading implicit-any
errors. It is not a compiling application candidate.

Separate projection changes only journal to exact61c15600: original application
type entry exit2/227, no new normalized diagnostic against the prior61 projection;
owned composable strict-full style exit0, zero violations. The projection is not
actual main compilation. Original journal61 stale async restore/list P2 and stable
ref remain with the sole original owner, pending exact corrected source.
Current source correction also awaits independent rereview.

No tests/list/collection/mount/native/backend/browser/product, C#/native build,
asset/DB/migration/security/current receipt acceptance or frozen-authority refresh
ran. Full factory/crashJournalRef/draft/server Document and actual Write.vue
integration remain open. See persistent-owner-boundary.md for the separately
requested second-group producer gap. All nine execution issues remain unaccepted;
#1809 remains tracking-only with incomplete child evidence.
