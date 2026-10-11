# Original full-draft checkpoint source handoff

Related to #2246, #2250, #2253, #1809 and #2294. Full draft is a separate source
commitc2bbe82bfdc38bcd9a2c6dd543ef9584d571ca54; current tested source
540e1069dbe6ab726e4ff845c7b8aeb9169db976. This is NOT full factory/runtime acceptance.

## Exact API and original owner

useAdminArticleWrite().authoringDraftCheckpointRuntime supplies:
- captureDraftCheckpoint(): immutable reference info or null;
- inspectDraftReference(reference): same-original-owner current info or null;
- validateDraftReference(reference,nativeSource): synchronous actual callback body check;
- restoreDraftReference(reference): original full-draft apply plus current inspection, or null;
- releaseDraftCheckpoint(reference): drop only that actual current checkpoint;
- invalidateDraftCheckpoint(): revoke current custody without granting authority.

The SAME original Writer draft owner builds its existing ArticleDraftSnapshot and
holds at most one immutable checkpoint. Top-level snapshot, copied original tags
and flat rights fields are frozen; body string is original form value. No second
live form, body index, draft persistence namespace, storage record or contract is
created. Only this original owner issues a random native cryptographic UUID plus
owner sequence locator. It is not a journal token/client revision/void save result,
server DocumentId, persistence or business grant. No native capture/dispatch occurs
inside draft capture; the Main actual native digest callback must pass its ORIGINAL
body to validateDraftReference. This source does not fabricate that caller join.

Actual fresh scope/document/registry/native owners are read before issuing and on
inspection: original raw principal/site, article/draft/document/context/epoch/source/
draft revisions, base/server/client/revision number, current Registry association,
actual mounted editor/session and public native revision, full semantic identity.
Inspection rejects replacement, stale body/metadata/version/scope, missing native
owner or lagging canonical publication. Reentrant capture is reserved; generation
changes refuse issuance and old reads cannot revoke a newly replaced custody slot.
Any title/body/summary/cover/category/tags/status/schedule/rights semantic change,
context change, real confirmation attempt, local-draft clear or actual Writer/scope
release invalidates custody. Immutable snapshot includes all ORIGINAL draft fields,
not merely body. savedAt is the original capture timestamp, not a fabricated durable
receipt; it is excluded from live semantic comparison through existing identity.

Restore is the existing applyDraftToForm with the original immutable full snapshot,
then fresh inspection. It never rewinds newer metadata: changed version already
revokes the reference. Current implementation requires the same live original owner/
mount/version; disposed-session hydration, native history/view restoration and full
factory integration are still unavailable and must refuse. Existing local/server
storage policy, plaintext/TTL/private cleanup and server permissions remain. Full
checkpoint persistence/multi-draft storage and safe eviction are not supplied.

## Caller P2 checkpoint stays independent

Minimum caller37663e96017ea7def60221ffbd7d4be7dfd97116 on its independently pushed
codex/chain2246-primary-p2-checkpoint excludes full draft. Its two P2 repairs have
actual730-source type exit2/221 and two-file style exit0. They attach real cleanup
custody before mount checks, clean failed initial setup even while preserving issued
binding, and consume native-before/after event/map before strict post-state. Actual
executor finally/cleanup alone calls lease.settle; abort/complete/scope stop is not
settlement. Two real lease source controls are UNRUN. Parent independent source
review of caller/draft is not treated as passed here.

## Exact original dependencies

Final Document producer5cf956db65c99ba0bf4e0ccd5712454006dbb542 four-path net increment
was consumed relative to9e7, postimages/apply/reverse checked. Registry/Group/ratio/
Snapshot unchanged by it. Caller reads actual admissionClosed and fails closed.
Registry five source findings were independently closed by parent; original Document
mutation/nested scope admission repairs are now consumed but independently reviewed
source remains pending. Supplier36 controls UNRUN, not qualification. No intermediate
691d Snapshot hunk. Real Snapshot owner1df constructor postimage retained. Real
Outline owner e49 single file matches exact c556→777 blob and remains the only
Outline change; owner AST/emit/CSS equivalence is source evidence, not UI/runtime.

## Current static results and limits

Actual730 frontend source files equal static program byte for byte. Actual UI6a,
real journal02cfd, canonical699 overlays and locked tools unchanged. Current full
application entry exit2/221, zero added/removed normalized errors vs isolated37663.
Strict-full source style passes3files/0violations (composable/request helper/Outline).
Initial full-draft five optional-chain findings and incorrect nested cause are in
raw logs, repaired in later source commits. Application still RED. No tests/list/
discovery/collection/candidate execution/mount/native/browser/backend/DB/privacy/
security/product/full lifecycle/frozen authority/catalog/receipt refresh was run.

All assigned execution issues unaccepted: #2246 native anchors/scroll open; #2250
actual multi-owner/context/factory lifecycle open; #2253 largedoc/epoch/restoration
controls UNRUN; #2256 native completion/future/business/cleanup/runtime open; #2280
migration/product prerequisites open; #2282 Live/#2245 acceptance open; #2284 actual
host/sync runtime open; #2286 preferences/#2280 product open; #2287 Focus/Typewriter
native/prerequisite open. #1809 tracking-only child evidence incomplete. #2245 owns
cache/refresh, no second-binding issuer. No Write.vue edit, second owner admission,
master push, merge, issue closure/deploy.91pending/79null/fullGeometryVerified=false.
