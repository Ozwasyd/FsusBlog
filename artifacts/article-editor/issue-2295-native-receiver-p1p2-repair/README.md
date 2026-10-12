# Exact native receiver P1/P2 source repair

UI owning source `f2533351ddf729d797b372d8ee6eba85e2f4234b` over rejected3de4e27d53ebb030d5715a71a3cd7784cb18714b.
Independent review found P1: nested breakMergeGroup notified after undo/reset/restore/
selection/redo mutation, potentially throwing before SFC model synchronization.
P2: added releaseRetainedSnapshot notification could throw in late unmount and
skip original remaining search/command/timer/observer/embed/viewport cleanup.
Original writer body byte equivalence was insufficient;3de is NOT usable approval.

P1: Only outermost real write entry clears/advances original document generation and
attempt-all notifies BEFORE original body/parameters. Internal nested store operations
only maintain write depth, with NO receiver callbacks. Notification/release-time
reentrant writes still refuse before body. The next outer failure remains before
mutation; same original generation/registration/first-cause/permanent-retirement guards
are preserved. No parallel owner/history/source or negative-condition relaxation.

P2: Early unmount retains first original retirement error; late original hook attempts
EACH original attachment/retained/search/command/timer/frame/observer/highlight/embed/
viewport cleanup independently, then rethrows that first cause. Failed search cancel/
alias cleanup retains controller/participant; timer/observer refs clear only after
successful original cancel. Original helper internals are unchanged and not newly
qualified. No falsezero/disposed/recoverable/eviction receipt; failed registration
custody still retained. Renderer/pipeline/WASM/C/hooks/native-session module untouched.

Three additive ORIGINAL controls: seven-operation second-notification failure matrix;
actual mounted original undo model synchronization with real context receiver; real
unmount callback failure followed by actual window viewport listener cleanup and
retained original receiver cause/custody. All UNRUN, source only. Original Web/Vitest
PROJECT compiler0/0, lint2files0, AST/SFC4files0 plus final controls0. Initial test import
TS2307 kept and normally repaired. Main actual full local-alias program remains
RED2/257 vs257 complete delta0/0, positions only normalized. Exact postimages/raw logs
are retained here; new independent review required, no old closure migration.

Main292 original Document intake independently bounded SOURCE CLOSED per parent,
separate from this rejected/repaired native receiver. All runtime/test/list/discovery/
import/native/security/privacy/receipt/race/backuprestore/IME/resource/restore/eviction/
provider/fullready/crossidentity/frozen authority HOLD remains. Local alias only,
normal hooks/push/open draft; no package/merge/close/authority refresh. Rollback this
repair to last usable ff91 producer instead of accepting rejected3de receiver behavior.
