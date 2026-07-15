# Issue #1141 local verification

## Scope

This verification is local only. It does not contact backup providers, TSA, S3, public chains, WAL archives, replicas, or any other external service. It does not claim that an in-process test deleted external state.

## Focused commands

```bash
node tools/check-audit-retention-catalog.mjs

dotnet build src/backend/FsusBlog.Server.csproj --no-restore -c Release

dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --no-restore -c Release \
  --filter 'FullyQualifiedName~AuditRetentionPolicyTests|FullyQualifiedName~AuditDetachedCheckpointTests|FullyQualifiedName~AuditLogStoreTests|FullyQualifiedName~LogCleanupServiceTests'
```

Request-plane isolation evidence remains focused rather than Production Fresh:

```bash
dotnet test tests/backend/FsusBlog.Server.Tests.csproj \
  --no-build --no-restore -c Release \
  --filter 'FullyQualifiedName~RequestAuditContextMiddlewareTests|FullyQualifiedName~NotificationStreamBoundaryTests|FullyQualifiedName~BinaryTransportHotPathContractTests'
```

Do not run `./tools/test.sh production` for this issue.

## Required matrix

- all declared actions have finite complete/pseudonym/aggregate limits and unknown actions fail closed;
- high-value and Critical are absent from cleanup exclusions;
- anonymous credential issuance is capped at 30 days;
- sensitive audit payload round-trips only while its retention-epoch DEK exists;
- after DEK destruction, copied ciphertext/backup bytes cannot reveal the original actor, path, device, or context;
- identity-free Merkle checkpoint is appended before DEK destruction and deletion;
- key-destruction evidence verifies under the public checkpoint key and contains no actor, target, trace, path, IP, session, or device value;
- legal hold is off by default, requires purpose/approval/finite expiry, is forbidden for issuance, and expires automatically;
- local fallback contains an encrypted envelope rather than raw identity and uses the same finite storage contract;
- backup/WAL/replica policies explicitly require operator attestation and do not claim local control;
- investigation purpose and step-up are required while row count remains capped at 200;
- anonymous, ordinary login, admin, notification stream, and binary transports retain their existing wire behavior.

Temporary DER keys, epoch DEKs, checkpoint packages, fallback files, and evidence files are created only below per-test temporary directories and must not be committed.
