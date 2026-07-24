# Content-addressed test evidence storage

Production Fresh stores large producer documents once per run and lets logical
receipts refer to the immutable object by SHA-256 digest. This storage contract
changes persistence and recovery cost; it does not change which test, assertion,
artifact, or failure is required for correctness.

## Run layout and identities

Each scheduler run owns one store:

```text
evidence-store/
    objects/<sha256>
    receipts/<logical-owner>.json
    journals/<run-id>.jsonl
    checkpoints/<run-id>.json
```

`runId` and `sourceState` bind every object, receipt, journal event, and compact
checkpoint. Object and logical receipt names are semantic domain identities; they
must not contain an issue or pull request number. A reference to another run or
source is invalid even when the referenced bytes happen to have the same digest.
Dynamic test evidence is therefore never reused across source states.

## Immutable objects and logical receipts

`RunEvidenceObjectStore.publishObject` canonicalizes one object envelope, hashes
the exact bytes, and publishes it through an exclusive temporary file plus an
atomic hard link. A concurrent publisher either creates that exact object or
verifies the already published bytes. Existing objects are never overwritten.
Directories and object files must be real directories and regular files; symlink
traversal, path escape, missing objects, byte tampering, unexpected schemas, and
cross-run references fail closed.

A `fsusblog.run-evidence-logical-receipt.v1` receipt keeps:

- logical owner and sorted required IDs;
- run and source binding;
- pass/fail/blocked decision;
- content-addressed object references;
- active-run and release-retention bindings;
- a canonical receipt content digest.

Multiple logical owners can reference the same producer document. Existing
projection and release-final readers use `readEvidenceDocument`, which validates
the envelope and complete reference graph before returning the original producer
document to the existing schema validator. Missing, tampered, cyclic, or
cross-run references are never converted into an empty or stale receipt.

## Scheduler journal and compact checkpoints

The test-matrix scheduler writes an append-only
`fsusblog.run-evidence-journal-event.v1` sequence. Each record binds:

- monotonic sequence;
- event type, tier, step, and status;
- run and source identity;
- the digest of an immutable incremental state patch;
- the event content digest.

Successful, failed, cancelled, interrupted, and timed-out results remain distinct.
The scheduler does not use wall-clock age or a time-to-live to decide whether an
event is valid.

A full compact checkpoint is generated only at explicit stage boundaries:
run start, run completion/failure, wall-clock termination, and evidence
finalization. The compatibility `checkpoint.json` remains a materialized view for
existing callers, but intermediate tier changes are journal records rather than
full checkpoint rewrites. Recovery validates the compact checkpoint, journal
continuity, every payload object, and then applies events after
`lastSequence`. A truncated record, sequence gap, corrupt checkpoint, missing
payload, or digest mismatch aborts recovery; failure and cancellation evidence is
not discarded.

## Reference-aware collection

Garbage collection is reachability-based, not age-based. It traverses every live
logical receipt and compact checkpoint, including nested object references.
Active run journal payloads and release-bound objects receive additional
protection. Only objects with no reachable receipt, checkpoint, active-run, or
release binding may be removed. The collector validates the graph before deleting
anything and rejects symlinks in the object directory.

## Correctness and optimization evidence

Storage metrics use `fsusblog.run-evidence-storage-metrics.v1` and record:

- JSON bytes written and immutable object bytes stored;
- object publishes, content reuse, and rewrite count;
- journal append and compact checkpoint counts;
- serialization CPU nanoseconds;
- recovery CPU nanoseconds, object reads, and replayed journal events;
- compatibility checkpoint write count and final materialized byte size.

The metrics declare `evidenceClass: optimization` and
`affectsCorrectness: false`. They may demonstrate reduced work, but they never
permit a failed or incomplete correctness receipt to pass. Correctness comes only
from object, receipt, reference, journal, checkpoint, and existing producer schema
validation.

## Local verification

```bash
node --test tests/tools/content-addressed-evidence-store.test.mjs
node --test tests/tools/test-matrix-scheduler.test.mjs
node --test tests/tools/evidence-projection.test.mjs
node --test tests/tools/test-evidence-receipt-schema.test.mjs
```

The focused storage suite covers deterministic deduplication, concurrent publish,
missing/tampered/cross-run/cyclic references, path escape and symlink rejection,
journal gaps, checkpoint corruption, crash/cancel recovery, reference-aware GC,
transparent projection reads, and optimization metrics. It requires no network,
database, browser, external package, or published package.
