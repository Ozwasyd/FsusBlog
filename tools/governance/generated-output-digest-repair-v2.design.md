# Digest-only generated repair v2 implementation draft

Status: implementation design for #3275, not a current authority or an accepted repair receipt. The current contract remains [Change contract](../../docs/development/change-contract.md). #3274 stays generated-only and cannot use this policy until a separate owner-controlled policy bootstrap has entered the trusted base.

## First checkpoint

`generated-output-digest-repair-v2.mjs` implements the isolated policy core. `config/schemas/post-merge-generated-output-digest-repair.schema.json` is its closed manifest schema. The focused tests use an in-memory trusted repository adapter to exercise policy decisions; they do not certify actual Git history, filesystem isolation, import discovery, producer execution, or merge eligibility.

No v1 or DAG v2 implementation, checker dispatch, production registry, or generated inventory changes in this checkpoint. No immutable commit-specific exception is introduced.

## Repository adapter checkpoint

`generated-output-digest-repair-repository.mjs` now implements exact bounded Git reads with replacement refs and grafts disabled, bounded all-parent history, and Linux sparse replay using Bubblewrap and an external strace observer. Only exact registered Git inputs and the canonical output are reconstructed; Node and its exact shared-library mounts are separately hashed. Inputs and the mount root are read-only, the existing canonical output alone is writable, and network/PID/user namespaces isolate execution. Missing tools or denied isolation fail closed. No producer-supplied observation is accepted.

The adapter tests create small real Git histories with a multi-file source/parser event, a PR merge, a later trusted policy bootstrap, and a generated-only candidate. The full core verifies all eight fresh sandbox instances. Real negatives cover replacement refs, symlink blobs, omitted imports, caught unregistered/ignored/external writes, source writes and chmod, symlink/hardlink attempts, network calls, history change-revert, and nondeterministic output. These are bounded synthetic repositories, not canonical producer qualification or independent acceptance. The actual production closure, minimal dispatch, registry, manifest producer, existing-policy regressions and maintained contract update remain pending.

## Proposed trusted registration

The final checker resolves this record from its trusted base and supplies the existing `changeContract.trustedPolicyFiles` as `protectedPolicyPaths`; this design does not introduce a second policy-path list. The complete closure below must be checked against real parent/source imports and file reads before the registration is enabled.

```javascript
{
    id: 'correctness-attempt-producers',
    repairClass: 'digest-refresh',
    manifest: 'artifacts/change-contract/correctness-producer-inventory-post-merge-repair.json',
    command: {
        executable: 'node',
        arguments: ['tools/test/generate-correctness-attempt-producers.mjs', '--write']
    },
    closure: [
        'config/testing/release-reliability-scenario-catalog.json',
        'config/testing/replay-qualification-producers.json',
        'config/testing/test-execution-envelope-applicability.json',
        'tests/matrix.yml',
        'tools/test-matrix/parse-matrix.mjs',
        'tools/test-matrix/production-fresh-run-bound-outputs.mjs',
        'tools/test/attempt-provenance.mjs',
        'tools/test/attempt-runner.mjs',
        'tools/test/correctness-attempt-producers.mjs',
        'tools/test/generate-correctness-attempt-producers.mjs',
        'tools/test/measurement-noise-envelope.mjs',
        'tools/test/temporal-context.mjs',
        'tools/yaml/parse-document.mjs'
    ],
    digestInputs: [
        'config/testing/release-reliability-scenario-catalog.json',
        'config/testing/replay-qualification-producers.json',
        'config/testing/test-execution-envelope-applicability.json',
        'tests/matrix.yml',
        'tools/test-matrix/production-fresh-run-bound-outputs.mjs',
        'tools/test/attempt-runner.mjs',
        'tools/test/temporal-context.mjs'
    ],
    output: 'config/testing/correctness-attempt-producers.json',
    outputSchema: 'fsusblog.correctness-attempt-producers.v1'
}
```

The producer roster is derived from the synchronized parent, not a fixed count. Only `sourceDigests` and the enclosing `contentDigest` may differ; generated metadata and every complete producer entry remain equivalent. Source digest keys must match the registered input roster and each digest is recomputed from that revision's exact Git blob.

## Trusted repository adapter boundary

The adapter must be constructed by the trusted-base checker and must not deserialize executable functions or authority choices from the candidate manifest. It supplies:

- `authorityRevision`: the exact trusted PR base, distinct from candidate head.
- `commit(revision)`: exact commit, parent list and subject from Git with replacement refs disabled.
- `blob(revision, path)`: an exact regular Git blob mode and bytes, with ancestor path safety, size and object identity verified before reading.
- `isAncestor`, `firstParentRevisions`, `revisionsBetween`, and `changedPaths`: complete bounded ancestry and all-parent history, with full-history change-revert coverage. It must not accept a candidate-supplied history list.
- `replay({revision, producer, attempt})`: a newly created isolated checkout on every call; only the registered output is writable, external network is denied, and all source reads and tracked/untracked/ignored writes are observed. It runs the registered command once, snapshots output mode/bytes, runs it again to test fixed-point behavior, and returns both snapshots plus exact logical read/write paths. Distinct `isolationId` values must correspond to actually distinct isolated checkouts, not labels selected by the producer.

The core requires two separate fresh replay calls for each of source parent, source revision, trusted base and candidate. It independently checks fresh determinism and the second execution's fixed point. A forged adapter observation is not addressed by pure core tests; the actual adapter and real process/filesystem negative tests are required before dispatch can be enabled.

Source history may contain a later owner-controlled policy bootstrap that is outside the producer closure. That does not license source, parser, output or mode drift. Repair candidate history may change only the exact manifest and output, including on intermediate commits; candidate policy edits remain forbidden.

## Remaining implementation and review

1. Build and test the actual exact-Git and isolated-replay adapter, including incomplete import closure, symlink/hardlink boundaries, outside-write attempts, ignored writes and real change-revert histories.
2. Add a minimal v2-only dispatch and trusted registration after shared-writer coordination. Preserve all v1 and DAG v2 behavior and run their existing regression suites.
3. Add the canonical manifest producer using the same adapter, then update the maintained Change contract paragraph without changing the old acceptance semantics.
4. Review and land the policy bootstrap through the existing authority path. An expected old-checker policy rejection is not a successful check.
5. Only after that base exists, refresh #3274 by a normal merge and replace its invalid ordinary binding with the v2 manifest. Verify it using the trusted-base checker and the actual eight fresh replay instances.

Estimated remaining work: one source owner, approximately two to four hours for the adapter, narrow dispatch, real-history negatives and independent review; the estimate does not include waiting for policy promotion or claim acceptance for #3274.
