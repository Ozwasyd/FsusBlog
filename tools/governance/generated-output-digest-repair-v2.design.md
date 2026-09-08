# Digest-only generated repair v2 implementation draft

Status: implementation design for #3275, not a current authority or an accepted repair receipt. The current contract remains [Change contract](../../docs/development/change-contract.md). The original #3274 inventory baseline was independently resolved by merged PR #3282 using its ordinary generated binding; no additional baseline is needed. This reusable v2 policy is not enabled until its canonical closure, checker dispatch and separate owner-controlled trusted-policy bootstrap are complete.

## First checkpoint

`generated-output-digest-repair-v2.mjs` implements the isolated policy core. `config/schemas/post-merge-generated-output-digest-repair.schema.json` is its closed manifest schema. The focused tests use an in-memory trusted repository adapter to exercise policy decisions; they do not certify actual Git history, filesystem isolation, import discovery, producer execution, or merge eligibility.

No v1 or DAG v2 implementation, checker dispatch, production registry, or generated inventory changes in this checkpoint. No immutable commit-specific exception is introduced.

## Repository adapter checkpoint

`generated-output-digest-repair-repository.mjs` now implements exact bounded Git reads with replacement refs and grafts disabled, bounded all-parent history, and Linux sparse replay using Bubblewrap and an external strace observer. Only exact registered Git inputs and the canonical output are reconstructed; Node and its exact shared-library mounts are separately hashed. Inputs and the mount root are read-only, the existing canonical output alone is writable, and network/PID/user namespaces isolate execution. Missing tools or denied isolation fail closed. No producer-supplied observation is accepted.

The adapter tests create small real Git histories with a multi-file source/parser event, a PR merge, a later trusted policy bootstrap, and a generated-only candidate. The full core verifies all eight fresh sandbox instances. Real negatives cover replacement refs, symlink blobs, omitted imports, caught unregistered/ignored/external writes, source writes and chmod, symlink/hardlink attempts, network calls, history change-revert, and nondeterministic output. These are bounded synthetic repositories, not canonical producer qualification or independent acceptance. The actual production closure, minimal dispatch, registry, manifest producer, existing-policy regressions and maintained contract update remain pending.

### Host executable trust boundary

Bubblewrap, strace and ldd resolve only to the exact paths `/usr/bin/bwrap`, `/usr/bin/strace` and `/usr/bin/ldd`; candidate PATH is never consulted. Each executable must be a non-redirected root-owned regular executable with no group/world write bits, and every physical ancestor must be a root-owned non-group/world-writable directory. The checker binds realpath, device/inode, mode, owner/group, size, timestamps and SHA-256; it checks identities before/after ldd, before each replay, and before/after each sandbox pass. A symlink redirect, ownership change, same-byte inode replacement, or byte drift fails closed. Replay-tool subprocesses receive only the fixed system PATH and explicit locale environment. This trusts the host system administrator, not candidate-controlled tool locations; it does not defend against a hostile root replacing the kernel or checker process.

The already-running checker Node remains the runtime trust anchor rather than a PATH-selected command. Its resolved executable and mounted libraries are identity-bound and rechecked; a root-owned Node installation is not newly required. The tests execute real candidate-PATH trap scripts to demonstrate they are ignored, and use controlled filesystem-observation mutations for redirected executables, changed bytes, changed inodes and task-owned executable observations. They never replace installed host tools.

Runtime file reads match exact mounted files, not their parent directories. Apart from the separately isolated procfs and device mounts, this holds during Node bootstrap as well as after producer loading. Successful or failed opens of an unmounted runtime-file sibling are rejected in both phases.

Only four exact absent runtime probes may report `ENOENT`: `/sys/devices/system/cpu/online`, `/sys/devices/system/cpu/cpu0/tsc_freq_khz`, `/sys/fs/cgroup/memory.max`, and `/sys/fs/cgroup/memory.high`. These were observed in real Node replay; sysfs is not mounted. The cgroup namespace is unshared so the last two probes do not depend on the host's task-specific cgroup path. There is no pre-bootstrap blanket `ENOENT` exemption. Observation mutations verify that successful reads of the allowlisted CPU/cgroup paths, absent sibling paths, and unmounted runtime-file sibling reads remain rejected; neither a parent directory nor all of `/sys` is allowlisted.

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
5. For a future independently authorized repair, require the enabled policy in its trusted base, then verify its v2 manifest using the trusted-base checker and the actual eight fresh replay instances. Do not recreate the already merged #3274 baseline.

Remaining work is the canonical closure qualification, narrow dispatch and registration, manifest producer, maintained contract update and independent policy review. The small real-Git tests above are not production qualification and the resolved #3274 baseline does not activate this policy.
