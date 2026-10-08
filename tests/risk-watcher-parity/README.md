# Isolated watcher parity risk harness

This test-only console harness uses the actual compiled production assemblies at
three immutable sources. It does not copy or implement a watcher, normalizer or
rescan tracker. It performs managed negative controls, preserves the raw decoder
order, and composes the real Linux fact adapter with the canonical normalizer and
rescan transitions. Native Windows NTFS and macOS APFS acceptance remains unrun.
It does not open a Vault, read Markdown files, or create native success receipts.

| Input | Immutable SHA | Implementation owner |
| --- | --- | --- |
| Windows | `a69a1ea853d617048649f55e3c74661ad21a51a8` | #2670 / PR #3952, `01a119f2-8d36-775e-92e4-17db390ff03c` |
| macOS | `0538404eba4c6818db5ff02f057ac2650d6d97d3` | #2671, `01a119f2-67ee-71da-802a-9a9e6aff703f` |
| Snapshot/event consumer | `7bab017f162852eea4f8c7888e1bccfcc9b3b9ea` | #2110/#2112 / PR #3977, `01a119f3-f339-77f4-a693-962284ae1016` |

Windows production and owner tests are byte-identical to
`3cc6fdb22797dec39c4252deeb2240e288243329`. The Linux acknowledgement method has
unchanged blob `01488c124d1971f1003828662a571e2fb2fef2e9`, also present in the saved
baseline `0a755584aa256995fd9997ca974806e8a0e29d2e`. A managed state fixture tests only
the actual pure acknowledgement transition; it supplies no native session or
verified receipt. Canonical repair belongs to the original Linux/rescan owners.

Use SDK 10.0.401 or a compatible .NET 10 SDK. Set these three MSBuild properties to
isolated source checkouts whose sole production projects have been built Release:

```bash
dotnet build tests/risk-watcher-parity/WatcherParityRisk.csproj -c Release \
    -p:WindowsSourceRoot=/workspace/risk-watcher-windows \
    -p:MacSourceRoot=/workspace/risk-watcher-macos \
    -p:ObservationSourceRoot=/workspace/risk-watcher-observations
dotnet tests/risk-watcher-parity/bin/Release/net10.0/WatcherParityRisk.dll
```

Each production project requires `dotnet restore <project> --locked-mode` followed
by `dotnet build <project> --no-restore -c Release`. Project paths are the Windows,
MacOS and Observations csproj files under their respective `src/article-vault/`
platform/module directories. Use `git worktree add --detach <path> <exact-SHA>`;
do not mix owner branches into a production checkout. `evidence/source-bindings.json`
records the actual production source and loaded assembly hashes from this run.

An optional case substring selects emitted checks:

```bash
dotnet tests/risk-watcher-parity/bin/Release/net10.0/WatcherParityRisk.dll windows.refusal
dotnet tests/risk-watcher-parity/bin/Release/net10.0/WatcherParityRisk.dll linux.baseline
```

The executable exits 1 on any failed expectation. Initial recorded parity run:
22 passed, 10 failed, exit 1. Added Linux baseline-only run: 0 passed, 1 failed,
exit 1. The final combined run should therefore retain 22 passed and 11 failed
until canonical owners repair the exact production contracts. These are 11
controls across two defect boundaries, not 11 separate product bugs.

Windows failures cover mandatory failure state, action/class consistency,
rename-path shape, pathless mutations, reason-code hygiene, timestamp validity,
source-path shape and NTFS identity declaration. Clean-watermark and body-digest
promotion refusals pass. The producer's future native path/reparse admission
remains separate from these portable shape controls.

Passing composite controls cover overflow obligations, independent batch
verification, resealed obligation deletion refusal, interrupted rescan retention
and structural completion awaiting native proof. macOS companion refusal controls
pass. No Windows/macOS normalizer adapter currently exists; no composite platform
acceptance is claimed. Native I/O cancellation, callbacks, handle leaks, root
permission loss and APFS/NTFS event sequences require real host execution.

No production files, shared registrations, project files, checkers, current
baselines or frozen reviewer branches are changed. This isolated harness is not
registered as platform qualification, and this draft is not a full SOURCE gate
or merge approval. Published findings are on PR #3952 comment 6053360996 and the
coordination/rescan issues. No package publishing, deployment or merge occurred.
