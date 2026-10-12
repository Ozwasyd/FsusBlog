# Original full-draft three-P2 source repair

Related to #2246, #2250, #2253 and #2294. Implementation8ea4003cb6d7f29de55c682a07530a51dce079ef;
exact tested/pushed source28362e479592da830d7f067bf70c0fdd45cd20ce. Based on finalc723
combination, preserving existing style and original donors. No runtime qualification.

Principal retirement: the original draft owner observes its ACTUAL raw principal
source synchronously. Any transition permanently retires that owner's draft slot,
including A→null/B→A before another inspect. Every transition invalidates generation;
old locators never revive and capture cannot reauthorize the retired original owner.
This also applies when the primary is not adopted. New document/session/draft ownership
must come from the original issuer; no fake owner/scope is constructed.

Original restore: reserve full checkpoint restore before inspect/native/materialization
readers, and reserve the shared original applyDraftToForm before its callbacks. Nested
capture/restore refuses. Original explicit recovery/discard entrypoints cannot mutate
this same form during the checkpoint restore. Each original setter is fenced both
before and AFTER its synchronous watchers using the SAME custody/generation and
actual owner inspection. If a tag watcher makes a newer rights edit, that invalidates
custody; outer restore stops before later rights/status setters. It never rewinds or
silently rolls back newer edits. Captured-only immutable materialization stays in the
original owner. Exceptions from mutation are propagated; finally always releases
reservations and restores the original suppression when the owner remains live,
or preserves terminal suppression when original cleanup has retired the owner.

Conflict pause: actual serverDraftSyncPaused is part of identity/admission and has a
synchronous invalidation listener. False→true→false cannot revive a locator. A paused
server conflict denies capture/inspection/restore. Checkpoint apply PRESERVES that
pause and never unconditionally clears it. Only the existing explicit comparison/
recovery/discard flow owns resolving the conflict. No new storage namespace, journal,
body/form store, authorization, fake successful save/backup or registry publication.

## Reentry/exception source matrix (UNRUN)

| Boundary | Actual source behavior | Evidence scope |
| --- | --- | --- |
| Principal A/null/B/A, unchanged document/form | Synchronous retirement and generation invalidation; capture/old ref refuse | New real-owner reactive-bootstrap control, unadopted primary; UNRUN |
| tagIds watcher edits later rights | Guard after tag setter refuses; newer rights remain | New original form/native/Registry control; UNRUN |
| Same watcher tries nested restore/capture | Both reserve before callbacks and refuse; outer edit is preserved | Same control, no fake token/result; UNRUN |
| Actual form setter throws | Real exception propagates; both reservations/suppression finally clean | New original form property probe; subsequent direct form edit checks real source watch; UNRUN |
| Original loaded server draft pause | Capture and restore refuse without changing pending/conflict state | New existing network-bootstrap DTO path, not fabricated persistence; UNRUN |
| Pause or semantic state changes at a setter boundary | Immediate generation/custody check aborts before next field | Source inspection only; no runtime claim |
| Context/permission/native version or release changes during guard reads | Original inspection refuses; expected custody cannot be published | Existing guards retained; UNRUN |
| Ordinary explicit recovery | Shared apply reservation; prior storage/compare/rights policy unchanged | Original source pathway; runtime acceptance pending |

Four counterexamples are in the existing complete Writer regression file. Only network/
bootstrap identity remains mocked; actual Writer/form/document/Registry/native/lease
owners remain real. Bootstrap principal is genuinely reactive to exercise the original
synchronous watcher. Source-only TypeScript AST parsing reports0 diagnostics; no candidate
modules, Vitest list/discovery/collection or hooks were executed. No test/config/matrix
selector/timeout/worker/coverage/qualification change. None of these controls is a pass.

## Exact dependencies and static checks

Original producer17c2e83ea1747baa1ca2f8de366ad7e249b2c23f four-path net consumed from5cf:
apply/index/byte/reverse checks0. Registry/Group/ratio/Snapshot unchanged. Parent confirms
specified original final consumer admission/Registry/Document source range SOURCE CLOSED;
39 supplier cases UNRUN. This is source review only, not runtime/cleanup/native qualification.
Original Snapshot1df and Outlinee49 correct postimages and existing style repairs retained.
Older caller37663 two-P2 source review is independently CLOSED and is not repeated here.

Actual730 frontend source files equal static program. Original application type exit2/221,
zero added/removed normalized diagnostics vs previous actual540e source; three-file strict-full
style exit0/0violations. Official locked Node24/TS6, UI6a and canonical699 config overlays
unchanged. Application still RED. No tests/list/mount/native/browser/backend/DB/security/
privacy/product/full lifecycle or frozen catalog/golden/authority/receipt refresh ran.
First plain push after environment resume failed due missing credential helper. Existing gh
GitHub authorization was verified; official per-command credential helper succeeded. Exact
remote source28362 was read back; no token was exposed or alternate environment used.

All nine execution issues remain unaccepted: #2246 native anchor/scroll; #2250 complete
context/multi-owner/factory lifecycle; #2253 largedoc/epoch/restoration controls UNRUN;
#2256 actual upload/File/journal source only, native completion/future/business/cleanup/
runtime open; #2280 migration/product prerequisites; #2282 Live/#2245 acceptance; #2284
actual host/sync scroll; #2286 user preferences/#2280; #2287 native Focus/Typewriter and
prerequisites. #1809 tracking-only incomplete. #2245 owns cache/refresh, not a second issuer.
Same-live-owner/mount checkpoint limitation remains; actual factory/refset/native hydration,
multi-draft persistence, full eviction/resource and privacy/product acceptance not supplied.
No issue closure, master push, merge/deploy.91pending/79null/fullGeometryVerified=false.
