# Independent late-recovery and admission revalidation

Tested production candidate: `2da720435c28cc481763af0ea7c117c82ea8ed0e`, parent
`aa8783767599a3ac0e2fa8f99e8a0161f5775b23`. This is independent protocol QA for the late
authority-read repair and the preceding admission-drift repair. No production or owner test file
is changed. Owner suite results are not substituted for the observations below.

The original SDK10.0.401/runtime10.0.12 freshly compiled the unchanged production files linked
by each diagnostic project, with the original owner fixture used for pure plan inputs and the
actual fsync file journal. All three builds have zero warnings/errors. No canonical success,
commit, rollback, zero-write, outbox or side-effect receipt is supplied by these diagnostics.

## Results and limits

- Original late-read diagnostic: exit0. After sealing UnknownRecovery and restarting the journal,
  explicit resume reads canonical recovery authority once (previous failing candidate: zero).
  The old head and unknown conclusion remain unchanged when that read returns null.
- Global admission: exit0, nine scenarios. Policy/permission-policy drift, actor/source mismatch,
  tamper, expiry, identity order, malformed observation and interrupted authority stream produce
  the exact expected refusal with no command calls or journal files.
- Per-item admission: exit0, eight drift scenarios. The affected item fails precisely while both
  healthy decisions remain eligible and the exact next healthy command interface is invoked.
  That command deliberately throws an unknown outcome; later business commands safely stop.
  This proves the next healthy invocation remains reachable, not that healthy mutations commit.
  Denied/absent/foreign-site receipts remain indistinguishable; private observation markers are
  absent from serialized decisions, receipts and persisted journal JSON.
- Atomic admission: exit0, the same eight item drifts refuse the entire frozen set with
  `article-bulk.execution-article-drift`, zero Prepare calls and no journal files or requery.
- New preservation diagnostic: exit0, null and still-unknown authority modes. Each performs three
  explicit resumes, restarting the actual journal/framework each time. Every read preserves the
  original execution/plan/checkpoint identity; every original journal file stays byte-identical.
  No reconciliation journal appears, the immutable unknown receipt remains non-retryable without
  zero-write proof, and selection/preflight are never re-queried. The single start marker counted
  is the original GroupCommitStarted event seeded through the framework append interface; it is
  not evidence of a business transaction having started or committed.

No new MUST_FIX was observed within these checks. The original late-read reachability failure and
fifth admission distinction pass on this exact source. This is not whole-bulk acceptance.
Known committed/zero-write reconciliation persistence, interrupted reconciliation-ledger prefixes,
real business transaction isolation, canonical revision CAS/outbox/audit coupling and real adapter
integration remain independently untested/blocked. Source review alone does not qualify them.
The original eight unchanged recovery probes, ordinary registry suites and owner full suite are
not rerun. No GitHub comments/PR, production deployment, merge or gate changes are performed.

## Reproduce

Run from the worktree root with the configured SDK:

```sh
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet build audit/bulk-recovery-13fb/LateRecoveryReadAudit.csproj --disable-build-servers -m:1 -v:q
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet build audit/bulk-admission-aa878/AdmissionAudit.csproj --disable-build-servers -m:1 -v:q
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet build audit/bulk-reconciliation-2da/PreservationAudit.csproj --disable-build-servers -m:1 -v:q
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet audit/bulk-recovery-13fb/bin/Debug/net10.0/LateRecoveryReadAudit.dll
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet audit/bulk-admission-aa878/bin/Debug/net10.0/AdmissionAudit.dll global
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet audit/bulk-admission-aa878/bin/Debug/net10.0/AdmissionAudit.dll per-item
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet audit/bulk-admission-aa878/bin/Debug/net10.0/AdmissionAudit.dll atomic
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet audit/bulk-reconciliation-2da/bin/Debug/net10.0/PreservationAudit.dll
```

The copied `bulk-recovery-13fb` harness and historical README are byte-for-byte from audit commit
`4dfdd3be5702faa02139206a619054ff445e6ad8`; `bulk-admission-aa878` is byte-for-byte from
`d740166a6e2ac9f067e85094b8cd5af0208f6e0e`. Their embedded Candidate fields and READMEs retain
the historical candidate labels `13fb1166...` and `aa878376...`. Their fresh binaries here link
the **2da720435...** source above. Interpret historical READMEs as earlier evidence, not current
findings; neither old harness nor old raw evidence is edited to relabel the result.

Current raw outputs with exact-source binding and exit codes:
`/tmp/fsusblog-bulk-audit-evidence/revalidation-2da720435.json`.
The new package-free lock is SDK-generated. Formatting/packaging checks are not business-DB
acceptance evidence.
