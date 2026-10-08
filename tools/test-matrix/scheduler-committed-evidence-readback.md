# Committed evidence readback

`tools/test-matrix/scheduler.mjs` exports
`schedulerCommittedEvidenceReadbackVersion = 1` and the synchronous API:

```js
verifyCommittedSchedulerEvidence({
    checkpointFile,
    expectedCommittedRevision,
    context,
    registry,
    registryEntry,
    repositoryRoot,
    expectedPayloadSchema
})
```

Every input is explicit. `expectedCommittedRevision` names the independently
expected revision **after** the writer committed. It is distinct from
`attachCheckpointCurrentRunEvidence`'s `expectedRevision`, which names its
baseline **before** writing. Readback never infers either value or increments
the caller's revision. The checkpoint schema is
`fsusblog.test-matrix.checkpoint.v1`; the wrapper schema is the existing
`fsusblog.current-run-evidence-reference.v1`.

The reader uses canonical objects and the validated journal without projection
repair. It checks the current run, attempt, source, worktree, candidate and build
identity using the existing context and locator contracts, selects exactly the
committed reference for the explicitly registered producer authority, and
verifies its wrapper and payload bytes/schema. Missing or mismatched inputs,
revision, identity or bindings throw.

The result contains only `committedRevision`, `finalOutputRef` and
`finalOutputDigest`. `finalOutputRef` is a copy of the actual committed
current-run reference, retaining its consumer, authority, producer, path,
`inputDigest`, `contentDigest` and `producerReceiptDigest` fields.
`finalOutputDigest` equals that reference's `inputDigest`: the SHA-256 of the
serialized **wrapper bytes**. The wrapper's separate `payload.digest` binds
payload bytes and is verified through `resolveEvidenceReferencePayload`; it
must not be substituted for the wrapper digest or either content digest.

This is a read-only committed-reference verifier. It does not write, repair,
reseal, publish, retry or confer terminal/domain qualification. An attached
reference may belong to a running checkpoint; terminal authority remains with
its owner. The release-final v2 output still requires its genuine producer and
locator registration from the original owners. The existing collector input
must not be relabeled as that output. Ordinary unit controls do not establish
durable concurrency, native terminal or cohort qualification.

This compatibility increment targets release-consumer source
`aeaf10e6f9fa215312c97d07c76c00ca55ed9e23`. It adds the same version 1
verifier from `7263179c059f8b119577ff83954c637bdc1a128f` with a strictly
read-only canonical reader. The existing private compatibility reader and
checkpoint writers retain their consumer-base behavior. Their global migration
is outside this increment.
