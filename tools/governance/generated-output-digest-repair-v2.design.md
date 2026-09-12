# Digest-only generated repair v2 implementation draft

Status: implementation record for #3275, not a current authority or an accepted repair receipt. The current contract remains [Change contract](../../docs/development/change-contract.md). The original #3274 inventory baseline was independently resolved by merged PR #3282 using its ordinary generated binding; no additional baseline is needed. This branch now contains the canonical v2 registry, schema, manifest producer, checker dispatch, exact Git/replay adapter, and focused regression coverage. The policy source is a trusted-policy bootstrap: the pre-existing/base checker is expected to reject these policy-file changes until an owner-controlled promotion makes the new checker authoritative.

## First checkpoint

`generated-output-digest-repair-v2.mjs` implements the isolated policy core. `config/schemas/post-merge-generated-output-digest-repair.schema.json` is its closed manifest schema and binds regular Git mode/object/SHA-256 identities; the candidate output identity is always read from the trusted external PR head, not selected by a manifest field. `change-contract.mjs` dispatches the v2 schema through the trusted-base adapter, while `change-contract-registry.mjs` binds the only admitted correctness inventory producer, its complete 13-file closure, canonical command/output, protected policy paths, and the exact source/merged PR #3271/outer-merge qualification tuple.

Existing v1 and DAG v2 behavior remains unchanged. No immutable commit-specific exception, dummy source edit, or generated inventory change is introduced. The manifest producer derives exact Git blob identities from the trusted adapter and emits only the closed v2 receipt; it cannot choose a command, closure, output, or policy authority.

## Repository adapter checkpoint

`generated-output-digest-repair-repository.mjs` now implements exact bounded Git reads with replacement refs and grafts disabled, bounded all-parent history, and Linux sparse replay using Bubblewrap and an external strace observer. Only exact registered Git inputs and the canonical output are reconstructed; Node and its exact shared-library mounts are separately hashed. Inputs and the mount root are read-only, the existing canonical output alone is writable, and network/PID/user namespaces isolate execution. Missing tools or denied isolation fail closed. No producer-supplied observation is accepted.

The adapter tests create small real Git histories with a multi-file source/parser event, a PR merge, a later trusted policy bootstrap, and a generated-only candidate. The full core verifies all eight fresh sandbox instances. Real negatives cover replacement refs, symlink blobs, omitted imports, caught unregistered/ignored/external writes, source writes and chmod, symlink/hardlink attempts, network calls, history change-revert, and nondeterministic output. These are bounded synthetic repositories and fixture simulations, not canonical producer qualification, production qualification, or merge eligibility. Linux Bubblewrap/strace execution is not available on the macOS development host, so those adapter cases are reported as skipped locally; the Linux workflow remains the required physical qualification.

### Host executable trust boundary

Bubblewrap, strace and ldd resolve only to the exact paths `/usr/bin/bwrap`, `/usr/bin/strace` and `/usr/bin/ldd`; candidate PATH is never consulted. Each executable must be a non-redirected root-owned regular executable with no group/world write bits, and every physical ancestor must be a root-owned non-group/world-writable directory. The checker binds realpath, device/inode, mode, owner/group, size, timestamps and SHA-256; it checks identities before/after ldd, before each replay, and before/after each sandbox pass. A symlink redirect, ownership change, same-byte inode replacement, or byte drift fails closed. Replay-tool subprocesses receive only the fixed system PATH and explicit locale environment. This trusts the host system administrator, not candidate-controlled tool locations; it does not defend against a hostile root replacing the kernel or checker process.

The already-running checker Node remains the runtime trust anchor rather than a PATH-selected command. Its resolved executable and mounted libraries are identity-bound and rechecked; a root-owned Node installation is not newly required. The tests execute real candidate-PATH trap scripts to demonstrate they are ignored, and use controlled filesystem-observation mutations for redirected executables, changed bytes, changed inodes and task-owned executable observations. They never replace installed host tools.

Runtime file reads match exact mounted files, not their parent directories. Apart from the separately isolated procfs and device mounts, this holds during Node bootstrap as well as after producer loading. Successful or failed opens of an unmounted runtime-file sibling are rejected in both phases.

Only four exact absent runtime probes may report `ENOENT`: `/sys/devices/system/cpu/online`, `/sys/devices/system/cpu/cpu0/tsc_freq_khz`, `/sys/fs/cgroup/memory.max`, and `/sys/fs/cgroup/memory.high`. These were observed in real Node replay; sysfs is not mounted. The cgroup namespace is unshared so the last two probes do not depend on the host's task-specific cgroup path. There is no pre-bootstrap blanket `ENOENT` exemption. Observation mutations verify that successful reads of the allowlisted CPU/cgroup paths, absent sibling paths, and unmounted runtime-file sibling reads remain rejected; neither a parent directory nor all of `/sys` is allowlisted.

## Trusted registration

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

The producer roster is derived from the synchronized parent, not a fixed count. Only `sourceDigests` and the enclosing `contentDigest` may differ; generated metadata and every complete producer entry remain equivalent. Source digest keys must match the registered input roster and each digest is recomputed from that revision's exact Git blob. The registry also fixes the real source parent/source commit, merged PR #3271, and merge/base/head identities, so a candidate cannot substitute a convenient historical tuple.

## Trusted repository adapter boundary

The adapter must be constructed by the trusted-base checker and must not deserialize executable functions or authority choices from the candidate manifest. It supplies:

- `authorityRevision`: the exact trusted PR base, distinct from candidate head.
- `commit(revision)`: exact commit, parent list and subject from Git with replacement refs disabled.
- `blob(revision, path)`: an exact regular Git blob mode and bytes, with ancestor path safety, size and object identity verified before reading.
- `isAncestor`, `firstParentRevisions`, `revisionsBetween`, and `changedPaths`: complete bounded ancestry and all-parent history, with full-history change-revert coverage. It must not accept a candidate-supplied history list.
- `replay({revision, producer, attempt})`: a newly created isolated checkout on every call; only the registered output is writable, external network is denied, and all source reads and tracked/untracked/ignored writes are observed. It runs the registered command once, snapshots output mode/bytes, runs it again to test fixed-point behavior, and returns both snapshots plus exact logical read/write paths. Distinct `isolationId` values must correspond to actually distinct isolated checkouts, not labels selected by the producer.

The core requires two separate fresh replay calls for each of source parent, source revision, trusted base and candidate. It independently checks fresh determinism and the second execution's fixed point. A forged adapter observation is not addressed by pure core tests; the actual adapter and real process/filesystem negative tests are required before dispatch can be enabled.

Source history may contain a later owner-controlled policy bootstrap that is outside the producer closure. That does not license source, parser, output or mode drift. Repair candidate history may change only the exact manifest and output, including on intermediate commits; candidate policy edits remain forbidden.

## Review and promotion status

1. The canonical closure and qualification tuple are registered and checked by the shared v2 path; the focused synthetic histories cover the exact negative matrix and preserve v1/DAG regressions. They do not substitute for Linux production qualification.
2. The base/old checker is expected to reject this bootstrap because the candidate changes trusted policy files and introduces a schema it does not know. That rejection is recorded for owner-controlled review, not claimed as a pass.
3. After owner-controlled promotion, a future independently authorized repair must carry the enabled policy in its trusted base and pass the actual eight fresh replay instances. Do not recreate the already merged #3274 baseline.
