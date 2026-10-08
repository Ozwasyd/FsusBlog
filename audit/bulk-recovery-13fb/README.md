# Independent revalidation of bulk recovery repair

Exact implementation candidate: `13fb1166c8ae6ba772f847caadec9c14d5ffa754`.
Original tested candidate: `b5cdc9eaa6d6f7910f8da75763c18baaab9b28b4`.
Original harness: `a1fd92c242d2ef633b2c341694cc779b3d40f6ac`.

The original harness is copied byte-for-byte into this isolated audit branch. All eight original
probes independently reran with original SDK10.0.401/runtime10.0.12, actual source-linked framework
and fsync journal. Build has zero warnings/errors. Original production/owner source and test files
are unchanged from the repair candidate. Owner-reported153/153 and owner probe results are not
used as substitutes for these independent observations.

| Probe | Independent result on repair |
| --- | --- |
| prepare-resume | exit0; remains RecoveryRequired/UnknownRecovery, no zero-write proof |
| unknown-retry | exit0; RetryEligible=false, unresolved retry rejected |
| cancel-retry | exit0; zero commands, same cancelled receipt replay, exact unstarted subset retry admitted |
| group-terminal-cut | exit0; missing aggregate finalized into honest RecoveryRequired |
| concurrent-unknown | exit0; duplicate invokes no second command |
| journal-cut | exit0; unsealed envelope ignored and stale head refused |
| journal-ack | exit0; sealed pointer survives lost acknowledgement |
| partial-group-proof | exit0; one of three existing unknown-group receipts cannot verify aggregate |

The four original reproduced defects are resolved within these tested protocol boundaries.

## Additional MUST_FIX: late unknown-outcome reconciliation is unreachable

The repair adds `ReadGroupRecoveryAsync`, so source review examined whether it remains reachable
after an unknown terminal is already sealed. A distinct diagnostic uses original owner pure plan
inputs, actual framework append interfaces and fsync journal. It supplies no successful business,
committed, rollback, zero-write or side-effect receipt. Both authority reads return null; the test
measures read reachability, not canonical transaction correctness.

Build and run from the worktree root:

```sh
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet build audit/bulk-recovery-13fb/LateRecoveryReadAudit.csproj --disable-build-servers -m:1 -v:q
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet audit/bulk-recovery-13fb/bin/Debug/net10.0/LateRecoveryReadAudit.dll
```

Actual exit1: initial canonical recovery read1; after sealing UnknownRecovery and restarting the
actual journal, explicit resume performs zero late authority reads, returns identical head and
keeps UnknownRecovery. Expected: an explicit reconciliation of an unresolved original transaction
must be able to consult canonical authority again, without rewriting prior receipts or rerunning
business commands. The terminal short-circuit in `ResumeAsync` returns before `ResumeAtomicAsync`;
the latter also excludes an existing UnknownRecovery group from its authority-read condition.
`ValidateGroupOutcomeAsync` returns no reconciled outcome, so revalidation does not provide an
alternative result-carrying reconciliation path.

Minimal owner fix direction: add an explicit append-only reconciliation receipt/attempt bound to
the original transaction identity and immutable unknown history, able to read later canonical
outcomes. Do not turn this into fresh business execution, automatic retry or receipt overwrite.
The probe establishes interface reachability only; actual late committed/zero-write conclusions
remain blocked without real canonical adapters.

Raw old failures and new outcomes are retained separately in
`/tmp/fsusblog-bulk-audit-evidence/final-probe-results.json` and
`/tmp/fsusblog-bulk-audit-evidence/revalidation-13fb1166.json`.

This is not whole-bulk qualification. The separately owned fifth admission-drift defect remains
outside this revalidation. Real business adapters, committed-group prefix recovery, business
transaction isolation, commit-phase cancellation and revision-CAS/outbox/audit coupling are still
blocked/unproved. No GitHub comment/PR creation, ordinary registry/full-suite rerun, deployment,
merge, production source/test edit, fake business receipt or gate weakening is performed.
