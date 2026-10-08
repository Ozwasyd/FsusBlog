# Bulk recovery diagnostic probes

Independent QA for #2385, #2387, #2395, #2396, #2397 and #2403. Candidate:
`b5cdc9eaa6d6f7910f8da75763c18baaab9b28b4`.

This audit links unchanged production executor/framework/file-journal sources and the unchanged
owner's pure plan-input support. It uses the original .NET SDK 10.0.401/runtime 10.0.12 and the
actual Linux fsync journal, including journal authority restart. Command and preparation interfaces
only throw or wait before throwing. The audit supplies no business success, committed transaction,
rollback, outbox, audit or side-effect receipt. The group checkpoint probe writes UnknownRecovery
through the actual framework append interface. The partial-proof negative only drops existing
framework-produced unknown-outcome receipts. Owner plan observations are protocol inputs, not
real application/DB facts. These probes do not qualify any product transaction, endpoint or UI.

The harness exists only on `codex/audit-bulk-recovery-20261008-sol`; integration requires the
implementation owner's approval. No production or owner test file is modified.

Build from the worktree root:

```sh
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet build audit/bulk-recovery-20261008/BulkRecoveryAudit.csproj --disable-build-servers -m:1 -v:q
```

Run one distinct probe:

```sh
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet audit/bulk-recovery-20261008/bin/Debug/net10.0/BulkRecoveryAudit.dll prepare-resume
```

Replace the final argument with a probe name below. Exit 1 denotes the stated invariant failing;
exit 0 is only the narrow protocol control passing. These outcomes are actual candidate observations,
not a product acceptance receipt. Raw results are retained in
`/tmp/fsusblog-bulk-audit-evidence/final-probe-results.json`.

| Probe | Expected invariant | Actual candidate result |
| --- | --- | --- |
| `prepare-resume` | Unproved prepare/release remains recovery-required until canonical release/zero-write proof | **MUST_FIX, exit 1:** RecoveryRequired becomes Cancelled/RejectedZeroWrite; zero new group-proof validations; independent verifier accepts |
| `unknown-retry` | Possibly committed unknown item requires canonical recovery before ordinary retry | **MUST_FIX, exit 1:** RetryEligible=true and new-revision retry admitted |
| `cancel-retry` | Exact explicit retry can select conclusively not-started original items and preserve cancellation history | **MUST_FIX, exit 1:** zero commands, three cancelled items, same receipt replay, but retry-not-eligible |
| `group-terminal-cut` | Sealed group terminal with missing aggregate enters/requires recovery | **MUST_FIX, exit 1:** UnknownRecovery group remains Executing with identical head and no aggregate |
| `concurrent-unknown` | Duplicate request during active command does not invoke another command or imply zero-write | **PASS, exit 0:** one call, duplicate Executing, terminal RecoveryRequired without zero-write proof |
| `journal-cut` | Envelope durable before pointer is prepared data; old sealed head remains authoritative | **PASS, exit 0:** prepared envelope ignored after restart; continuation succeeds; stale head rejected |
| `journal-ack` | Sealed pointer survives missing append acknowledgement | **PASS, exit 0:** restart sees Admitted/EventCount2 exactly once |
| `partial-group-proof` | Partial receipts cannot verify an exact group terminal | **PASS, exit 0:** dropping two of three unknown-group item decisions produces aggregate-receipt-inexact |

Fix directions belong to the implementation owner:

- Preserve unproved preparation/release as unresolved; require authority-backed release/snapshot
  evidence before a zero-write terminal, including independent verification.
- Distinguish proved failure/not-started retry eligibility from unresolved canonical outcomes.
  An explicit expected revision does not resolve whether the previous transaction committed.
- Admit safe exact retry subsets from not-started cancelled attempts while preserving old receipts.
- Resume incomplete evidence after every sealed group terminal. Reconcile known outcomes through
  the same canonical transaction identity without reexecuting business commands.

Still blocked: actual business commit-to-journal gaps, known committed group receipt prefixes,
per-item successful/failed business transaction isolation, commit-phase cancellation, revision CAS
and outbox/audit coupling. The exact candidate contains only declarations of the new command
interfaces; every production adapter remains Unavailable and production preflight/execution/group
proof authority remains unavailable. No fake business receipts, schema admission bypass, gate
changes, historical evidence, original registry suite reruns, deployment or merge are used.

Initial CLI-home and harness compile failures are retained. The final harness build passed with
zero warnings/errors; configured C# source style and diff whitespace checks passed. The empty
package lock is produced by the SDK from this package-free diagnostic project. None of these
checks substitutes for canonical backend/domain acceptance or authorizes integration.
