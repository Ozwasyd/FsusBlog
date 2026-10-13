# Linux process observation verification record

This is an issue-scoped execution record for #3620, not a canonical producer receipt,
independent acceptance, release qualification, or an instruction to close an issue.
The issue remains blocked on current canonical execution and finalized cleanup.

## Candidate and scope

- Source tested: `3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`.
- Latest `origin/master` was fetched and verified before work; it matched the planning snapshot.
- Branch: `codex/chain-3620-linux-observation`.
- Run identity: `chain3620-20261008T024653Z-3bc9bacd55b4`.
- Environment: configured FsusBlog cloud checkout, `/workspace/FsusBlog`, Linux x86_64.
- Issue #3620 and all five current comments were reread, including the three supplied comment IDs.
  Downstream #3524 and #3527 bodies were also read for their original admission boundaries.
- Assignment: execution issue #3620 only; no tracking issues or recorded external prerequisites.
- No implementation change was needed to make the existing collector's focused assertions pass.
  The integrated Linux collector and current resource documentation already contain the required
  ENOENT/healthy-proc/nonempty-boot/exact-directory-absence discrimination.
- This branch adds evidence only. It does not change collector, canonical test membership,
  authority indexes, generated fixtures, policy, downstream implementations, or issue definitions.

## Executed checks

| Command | Toolchain | Exit | Result | Raw evidence |
| --- | --- | --- | --- | --- |
| `node --test tests/tools/run-once-process-identity.test.mjs` | Node 24.19.0 | 0 | 22 passed, zero failed/skipped | [Identity](process-identity.tap) |
| `node --test tests/tools/physical-execution-process-tree.test.mjs tests/tools/production-build-owner-identity.test.mjs tests/tools/scheduler-finalizer-boundary.test.mjs` | Node 24.19.0 | 1 | 53 passed, 13 failed, 11 skipped | [Containment](containment-cleanup.tap.gz) |
| `node --test tests/tools/production-resource-enforcement.test.mjs` | Node 24.19.0 | 1 | 97 passed, 42 failed, 1 skipped | [Resources](resource-enforcement.tap.gz) |
| `node --test tests/tools/production-build-owner-identity.test.mjs tests/tools/scheduler-finalizer-boundary.test.mjs` | Node 24.19.0 | 0 | 18 passed, zero failed/skipped | [Owner/finalizer](build-owner-finalizer.tap) |
| `/workspace/chain3620-node/bin/node --test tests/tools/run-once-process-identity.test.mjs tests/tools/production-build-owner-identity.test.mjs tests/tools/scheduler-finalizer-boundary.test.mjs` | Node 24.16.0 | 0 | 40 passed, zero failed/skipped | [Pinned focused](pinned-node-focused.tap) |
| `node tools/run-test-matrix.mjs validate` | Node 24.19.0 | 1 | Rejected matrix parsing; no matrix acceptance | [Matrix](matrix-validate.log) |
| `./tools/test.sh backend-unit --fresh` | Node 24.19.0 | 1 | Rejected before producer execution | [Original lane](backend-unit.log) |
| `./tools/test.sh backend-unit --fresh` | Node 24.16.0, SDK 10.0.401 | 1 | Correctness producer inventory gate rejected before execution | [Pinned original lane](backend-unit-pinned-node.log) |
| `dotnet restore tests/migration/FsusBlog.Migration.Tests.csproj --locked-mode` | SDK 10.0.401 | 0 | Locked restore passed; existing NU1903 warnings retained | [Restore](migration-locked-restore.log) |
| `/workspace/chain3620-node/bin/node tools/governance/check-change-contract.mjs --repository` | Node 24.16.0 | 0 | Repository metadata policy passed | [Metadata](change-contract-repository.log) |

The real child-exit case, live group/start identity, absent PID, present PID/missing stat,
reappearing PID, missing/empty boot identity, unreadable root/boot, and EACCES negative
controls all ran in the original identity test owner. Darwin and Windows controlled
collector cases passed, but native Darwin/Windows acceptance was not run. The finalizer
unit model is explicitly a component model; its pass does not certify scheduler cleanup.
The two failing-suite transcripts are losslessly gzip-compressed to retain the
original Node reporter whitespace and bytes. Their decompressed SHA-256 digests
are recorded separately; compression/decompression equality was checked.
All broad-suite failures were observed on unchanged master source, before evidence edits.
Their original assertions and skips remain intact. There is no claimed newly repaired
containment behavior, current downstream receipt, successful MySQL execution, or clean finalizer.

## Tooling setup and capability limits

Official Microsoft `dotnet-install.sh --channel 10.0 --install-dir
/workspace/chain3620-dotnet --no-path` installed SDK 10.0.401 with runtime 10.0.12.
[Installation output](dotnet-install.log) records the exact official archive and byte count.
Restore used task-local `DOTNET_CLI_HOME=/workspace/chain3620-dotnet-home` and
`NUGET_PACKAGES=/workspace/chain3620-nuget`; lockfiles were not changed.

The default Node 24.19.0 differs from the canonical authority index's 24.16.0.
Official Node 24.16.0 was downloaded from `nodejs.org/dist/v24.16.0`, and the Linux
archive was checked against the [official selected SHA-256](node-selected-shasum.txt).
Pinned-version focused tests passed; the original canonical lane is separately retried
with that Node and the installed SDK. It refused with the original
`correctness attempt producer inventory differs from canonical authorities` gate.
This retry reached no Migration/MySQL producer or finalized scheduler cleanup.
No parser/index policy is rewritten to admit the default Node.

The repository's `npm ci --ignore-scripts` parser setup initially failed because its
default cache was outside the writable task roots. Both installs passed after setting
`--cache /workspace/chain3620-npm-cache`; the initial failures and successful retries
are retained. No package version, lockfile, lifecycle script, or gate was changed.

[Capabilities](capabilities.log) preserve these actual environmental limits:

- `systemctl --user show-environment` exits 1: no user bus, `DBUS_SESSION_BUS_ADDRESS`,
  or `XDG_RUNTIME_DIR`. `/run/user/1000` is absent. No global manager configuration was changed.
- The cgroup v2 mount is read-only and `cgroup.subtree_control` is not writable.
  The visible mountinfo root is `/..`; the original memory path verifier rejects it.
  No controls were fabricated, normalized around the gate, or moved outside ownership.
- Docker Engine 28.4.0 is reachable, but the catalog-pinned MySQL image
  `mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d`
  is absent. [Image preflight](mysql-image-preflight.log) exits 1. No image pull, fixture
  creation, SQL execution, or production-resource use was performed.
- The failed interrupted-owner resource fixture explicitly retained diagnostics at
  `/tmp/fsus-build-crash-WWAE59` and `/tmp/fsus-build-crash-WWAE59-capacity`.
  This record does not certify resource absence or release the retained reservation.

The evidence Markdown was checked using the repository configuration and pinned
`markdownlint-cli2@0.23.1`; it exited 0. The native docs style selector excluded this
artifact path, so its zero selected-file output is not used as lint proof.

## Remaining acceptance and next action

#3620 is **blocked**, with current Linux identity behavior verified. Its entire owned
assignment contains one issue. No downstream or tracking issue is silently omitted.
#3524 and #3527 require their own current canonical/native evidence and remain outside
this chain's implementation ownership.

The smallest runtime next action is a task-isolated Linux executor with a usable
non-root systemd user manager, a genuinely delegated writable cgroup v2 hierarchy with
valid visible mount paths, the catalog-pinned MySQL image, and the locked SDK/dependency
cache. Keep all original admission, cleanup, negative-control, and receipt-binding gates.
Then rerun the current canonical execution/finalizer, exercising normal, failed,
cancelled, interrupted/repeated and residual-cleanup paths as their owners require.
The current canonical owner must reconcile the correctness-attempt producer inventory
through its original producer and trusted review: matching the pinned Node alone did
not satisfy that gate. Any source/authority admission failure must first be handed to its canonical owner,
not repaired by weakening the collector or importing another chain's guessed work.

No PR is merged, issue closed, auto-merge enabled, deployment attempted, master pushed,
production migration run, or trusted qualification receipt manufactured by this record.
For evidence corrections, supersede this observation while retaining failed logs;
for a demonstrated live/unknown-to-dead regression, revert only the exact collector
change through the standard separate review phase.
