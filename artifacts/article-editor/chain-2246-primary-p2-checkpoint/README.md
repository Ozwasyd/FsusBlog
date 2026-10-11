# Minimum primary caller two-P2 checkpoint

Related to #2246, #2250 and #2253. Actual tested/pushed source
37663e96017ea7def60221ffbd7d4be7dfd97116 on codex/chain2246-primary-p2-checkpoint.
This source excludes full-form draft work. Parent can review/use this checkpoint
immediately; current main branch's full-draft work is a separate later commit.

First caller P2: actual producer binding is retained, but the same stable consumer
and original context/lifetime subscriptions attach BEFORE native mount validation.
retainedPrimaryReady becomes true only after validation. Any failed initial caller
adoption cleans the actual Writer resources while preserving original issued document
custody. Unmount skips original cleanup only for genuinely ready consumer setup.
Cleanup attempts each original operation independently, so a failed port cannot skip
channel/scope teardown. Actual failure and its cause are preserved; failed synchronous
cleanup never becomes a later noop success. No native/request settlement follows merely
from scope stop/abort. Nested cause is correct; both actual errors remain in AggregateError.

Second caller P2: transaction entry checks original live handle/mount/identity and
real beforeRevision versus original Writer, plus AFTER revision from the actual public
native session. UI6a commits/emits atR+1 while original model isR. It then passes the
actual event/position map once to original runtime, and checks strict native/model
post-state. No second dispatch, inverse map, rollback receipt or relaxed ordinary
snapshot guard is introduced. Rejected/stale event refuses before mutation.

Actual original request executors and five original Writer async request/recovery
paths call their actual lease.settle only after awaited future and cleanup return.
Cancel, logical complete and scope stop still do not settle pending futures. Two
source controls use the original adapter/lease and actual Promise cancellation/scope
stop paths; UNRUN, not ledger/native/product evidence.

Final producer9e7b9de1cee9925f78ade7e6a24b2cc01882fe8e six-path NET offer consumed;
no intermediate691d Snapshot edit. Original Snapshot owner file from
1df8314c8000130448d798e7bf5d38f50e7f1ecd is preserved exactly. Its four constructor
errors are corrected by its sole owner, not attributed to the retained producer.
Registry five findings independently closed; Document two new admission/mutation
P2 findings remain original-owner work, so this producer is still UNACCEPTED.
No second retained owner admitted or qualified. Outline file unchanged; independent
single-file style owner handles its existing findings.

Actual730-file full application program matches this exact checkpoint byte for byte.
Original type entry exit2/221, no new normalized diagnostics versus c8 caller source;
four original Snapshot errors removed. Two owned source files strict-full style
exit0/0violations. Initial missing/incorrect catch-cause finding is retained in raw
logs, not called green. Original canonical699 config overlays, actual UI6a and locked
tools remain. Application still RED. No test/list/discovery/collection/mount/native/
backend/privacy/security/product/runtime or frozen authority refresh ran.

Complete chain accounting unchanged: #2246 native anchor/scroll open; #2250 primary
source only/producer and lifecycle acceptance open; #2253 controls/largedoc/epoch/
restoration UNRUN; #2256 actual upload/File/journal source only, completion/business/
cleanup/runtime open; #2280 migration/product prerequisites open; #2282 Live/#2245
acceptance open; #2284 host/compare/sync runtime open; #2286 user preference/#2280
open; #2287 Focus/Typewriter prerequisites/runtime open; #1809 tracking-only incomplete.
No issue merge/closure/deploy;91pending/79null/fullGeometryVerified=false.
