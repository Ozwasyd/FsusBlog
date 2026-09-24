# Content-addressed test evidence storage

Production Fresh stores each large producer document once per run; logical
receipts refer to the immutable object by SHA-256. This changes persistence and
recovery cost, not the test, assertion, artifact, or failure required for
correctness. The [Evidence Projection Contract](evidence-projection-contract.md)
remains the canonical consumer boundary.

## Run layout and identity

Each scheduler run owns one store:

```text
evidence-store/
    objects/<sha256>
    receipts/<logical-owner>.json
    journals/<run-id>.jsonl
    checkpoints/<run-id>.json
```

`runId` and `sourceState` bind every object, receipt, journal event, and compact
checkpoint. Object and logical-receipt names are semantic domain identities, not
issue or pull-request numbers. A reference to another run/source is invalid even
when its bytes share a digest; dynamic evidence is never reused across source
states.

## Immutable objects and logical receipts

`RunEvidenceObjectStore.publishObject` canonicalizes one envelope, hashes exact
bytes, and publishes via an exclusive temporary file plus atomic hard link. A
concurrent publisher creates that object or verifies the existing bytes; existing
objects are never overwritten. Directories and objects must be real directories
and regular files. Symlink traversal, path escape, missing objects, byte tamper,
unexpected schemas, and cross-run references fail closed.

`fsusblog.run-evidence-logical-receipt.v1` keeps the logical owner and sorted
required IDs; run/source binding; pass/fail/blocked decision; content-addressed
object references; active-run and release-retention bindings; and a canonical
receipt-content digest. Multiple owners may reference one producer document.
`readEvidenceDocument`, used by existing projection and release-final readers,
validates the envelope and complete reference graph before passing the original
document to the existing schema validator. Missing, tampered, cyclic, and
cross-run references never become an empty or stale receipt.

`RunEvidenceObjectStore` accepts an explicit `readOnly: true` observation mode. Opening this mode requires the
existing root and all store directories; it never creates missing state. Object/receipt/journal/checkpoint
publication and collection reject before any write or lock acquisition. Resource-retention observation uses this
mode rather than reconstructing an incomplete store while deciding whether capacity may be released.

## Scheduler journal and compact checkpoints

The matrix scheduler appends `fsusblog.run-evidence-journal-event.v1` records,
each binding a monotonic sequence; event type, tier, step, and status; run/source
identity; the digest of an immutable incremental state patch; and the event
content digest. Success, failure, cancellation, interruption, and timeout stay
distinct; validity never depends on wall-clock age or TTL.

A full compact checkpoint is written only at explicit boundaries: run start,
run completion/failure, wall-clock termination, resource reconciliation, and evidence finalization.
Compatibility `checkpoint.json` remains the materialized view for existing
callers; intermediate tier changes are journal records, not full rewrites.
Recovery validates the compact checkpoint, journal continuity, and every payload
object, then applies events after `lastSequence`. Truncation, sequence gaps,
checkpoint corruption, missing payloads, or digest mismatch abort recovery;
failure and cancellation evidence is retained.

Changed scheduler resource grants are intermediate journal events too: the complete run/source/owner-bound state is
under `resourceUtilization.resourceGrants`, and the existing worker-facing `resource-grants.json` is its mutable
projection, not a second allocation authority. A successful kernel read-back precedes journal fsync, projection and
resource-service payload release. Recovery must pass each event's referenced payload to the state-patch reducer.
Fresh/resume admission uses the durable journal even if a mutable compatibility checkpoint claims a newer revision.
It rejects active grants, failed resource cleanup and missing or mismatched projections before resetting evidence; this
retention guard does not itself reconcile a dead owner's resources. See [resource enforcement](issue-1072-production-resource-enforcement.md).

The same scheduler-owned reader exposes original build-owner retention observations. They bind the exact run,
namespace, source, candidate, target, budget policy and original scheduler token, require a nonempty journal at least
through its compact-checkpoint sequence, and reject missing or inconsistent worker projections. Missing grant state
does not certify settlement. Capacity and build GC therefore retain the original owner after OS resources and private
carriers are gone while its grants or interrupted/failed cleanup remain unresolved. This read-only observation does
not acquire a new scheduler incarnation, clear grants, rewrite failures or delete build records.

Explicit dead-build resource reconciliation is a separate scheduler-owned operation. It holds a new exact scheduler
lease and the original build's reclaim exclusion while the existing process/resource owners prove absence. Only then
does it append `resource-grants-reconciled` to this same journal, retaining the previous grant state and original failure.
The old owner token remains on the zero grant document; the new recovery token is recorded separately. An interrupted
run becomes failed rather than successful. Partial publication retains capacity; exact retries rebuild compact,
compatibility and worker views from the committed journal without adding another release event. Serialized cleanup
reports cannot call this writer, and ordinary Fresh/resume do not implicitly perform this reconciliation.

## Reference-aware collection

Garbage collection is reachability-based, never age-based: it traverses every
live logical receipt and compact checkpoint, including nested references, while
protecting active-run journal payloads and release-bound objects. Only objects
with no reachable receipt, checkpoint, active-run, or release binding may be
removed. The collector validates the graph before deletion and rejects object
directory symlinks.

## Correctness and optimization evidence

`fsusblog.run-evidence-storage-metrics.v1` records JSON bytes written; immutable
object bytes stored; publishes, content reuse, and rewrites; journal appends and
compact-checkpoint counts; serialization CPU nanoseconds; recovery CPU
nanoseconds, object reads, and replayed events; and compatibility-checkpoint
write count and final materialized byte size. It declares
`evidenceClass: optimization` and `affectsCorrectness: false`: metrics may show
reduced work but never pass a failed/incomplete correctness receipt. Correctness
comes only from object, receipt, reference, journal, checkpoint, and existing
producer-schema validation.

## Local verification

```bash
node --test tests/tools/content-addressed-evidence-store.test.mjs
node --test tests/tools/test-matrix-scheduler.test.mjs
node --test tests/tools/evidence-projection.test.mjs
node --test tests/tools/test-evidence-receipt-schema.test.mjs
```

The focused suite covers deterministic deduplication, concurrent publish,
missing/tampered/cross-run/cyclic references, path-escape and symlink rejection,
journal gaps, checkpoint corruption, crash/cancel recovery, reference-aware GC,
transparent projection reads, and optimization metrics. It requires no network,
database, browser, external package, or published package.
