# Independent admission-drift diagnostic

Exact candidate `aa8783767599a3ac0e2fa8f99e8a0161f5775b23`, parent
`13fb1166c8ae6ba772f847caadec9c14d5ffa754`. This isolates the fifth reported defect; it does not
rerun the eight unchanged recovery controls or the unresolved late-unknown reconciliation case.
Owner168/168 is not substituted for these independent results.

The audit uses original .NET SDK10.0.401/runtime10.0.12, unchanged source-linked production code,
the actual fsync file journal, and original owner pure plan-input support. Negative authority
observations exercise the original permission/site masking and validation methods. Canonical
command/preparation interfaces only throw; the audit supplies no business success, committed
transaction, rollback, outbox, audit or side-effect receipt. This is protocol evidence, not real
production permissions/DB or product qualification.

```sh
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet build audit/bulk-admission-aa878/AdmissionAudit.csproj --disable-build-servers -m:1 -v:q
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet audit/bulk-admission-aa878/bin/Debug/net10.0/AdmissionAudit.dll global
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet audit/bulk-admission-aa878/bin/Debug/net10.0/AdmissionAudit.dll per-item
DOTNET_CLI_HOME=/workspace/.setup/dotnet-home /workspace/.setup/dotnet/dotnet audit/bulk-admission-aa878/bin/Debug/net10.0/AdmissionAudit.dll atomic
```

All three independent commands exited0, covering25 deterministic observation scenarios:

- Global9: current policy/permission-policy drift, actor/source mismatch, tampered plan, expired
  plan, reordered identities, invalid observation shape and interrupted authority stream. Each
  exact expected rejection occurs with zero command calls and no journal files.
- Per-item8: revision, denied permission, foreign site, absence, permission digest, lifecycle,
  applicability and dependency drift. The affected first item receives the precise failed reason
  with unchanged frozen expected revision, no observed/new revision and no side effects. Both
  healthy frozen decisions stay eligible; the exact next healthy item is invoked. Its deliberately
  unknown canonical outcome safely stops the remaining invocation. This proves drift does not
  block the next healthy invocation, not that all healthy business mutations actually commit.
- Atomic8: those same drifts on a middle item reject the entire frozen set with
  `article-bulk.execution-article-drift`, zero PrepareAsync calls, no journal files and no requery.

Privacy controls also pass: denied/absent/foreign-site observations produce an identical refused
item receipt digest; private current revision/lifecycle/site markers do not occur in serialized
decisions, receipts or any persisted journal JSON. Source inspection confirms the original
observation shape validation and permission/site masking remain intact. Real permission-service
integration is still unproved; no rights or privacy gate is bypassed.

The focused source diff moves item drift into per-item decisions while retaining global authority
checks, expiry recheck and exact ordered/integrity validation. Atomic still compares every frozen
item digest. Existing global policy assertions remain; the old per-item-global revision/permission
refusal assertions are replaced with strategy-specific controls, not treated as waived security.

Within these tested observation/admission boundaries, the original fifth defect is resolved and
no new MUST_FIX is observed. Whole-bulk acceptance is withheld: actual healthy-item business
commits, real permission/DB integration, canonical CAS/outbox/audit coupling and the previously
reported late-UnknownRecovery reconciliation defect remain blocked/unresolved. No production or
owner test file changes, GitHub comments/PR creation, unchanged broad suite reruns, gate changes,
deployment or merge are performed. Old evidence and harnesses remain untouched.

Raw outputs: `/tmp/fsusblog-bulk-audit-evidence/admission-aa878376.json`.
Final audit build has zero warnings/errors, after scoped whitespace formatting only on the new
audit Program.cs. The package-free lock is SDK-produced. Formatting and packaging checks are not
canonical backend acceptance evidence.
