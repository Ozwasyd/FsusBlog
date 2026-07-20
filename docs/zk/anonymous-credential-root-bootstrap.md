# Anonymous credential root bootstrap runbook

This runbook covers the production bootstrap and rotation evidence flow for
`fsus.anonymous.comment.v3` anonymous credential roots. It does not generate a
credential root, revocation root, issuer key, private key, witness, proof, or
verifying key hash.

## Scope

Use this process only after the trusted setup and verifying-key manifests have
real production material:

- `security/zk/provenance/comment-v5-trusted-setup.manifest.json` has
  `production_usable=true`, `ceremony_status=verified`, and a real
  `verifying_key_hash`.
- `config/zk/anonymous-comment-v5-verifying-key.manifest.json` has
  `production_usable=true` and the same real `verifying_key_hash`.
- The circuit-native issuer service has produced a public issuer key hash.
- The credential root and revocation accumulator root were computed by the
  issuer/root ceremony outside this repository.

The committed fail-closed manifests intentionally keep
`production_usable=false` and are rejected by this bootstrap flow. They may carry
the current placeholder verifying-key artifact hash only for repository
consistency checks; that hash is not production rollout approval.

## Input

Prepare a JSON request with this public material only:

```json
{
  "schema": "fsusblog.anonymous-credential-root-bootstrap-request.v1",
  "epoch": 2026062001,
  "credentialRootHash": "<64-char-hex>",
  "revocationRootHash": "<64-char-hex>",
  "issuerPublicKeyHash": "<64-char-hex>",
  "circuitId": "fsus.anonymous.comment.v3",
  "circuitNumericId": 7,
  "publicInputLayoutVersion": 4,
  "verifyingKeyHash": "<64-char-hex>",
  "expiresAt": "2026-07-20T00:00:00Z",
  "graceExpiresAt": "2026-07-27T00:00:00Z",
  "operatorId": "admin:root-ops",
  "reason": "initial production root bootstrap"
}
```

The input must never contain issuer private key, credential secret, proof
witness, issuer signature, credential opening, raw proof, or real user/account data.

## Offline Validation

Run the validator/evidence generator:

```bash
node tools/security/bootstrap-anonymous-credential-root.mjs \
  --input /secure/ops/anonymous-root-2026q3.json \
  --trusted-setup-manifest security/zk/provenance/comment-v5-trusted-setup.manifest.json \
  --verifying-key-manifest config/zk/anonymous-comment-v5-verifying-key.manifest.json \
  --evidence .tmp/security/anonymous-credential-root-bootstrap.json
```

The tool validates hash format, `circuitId =
fsus.anonymous.comment.v3`, `publicInputLayoutVersion = 4`, trusted setup
manifest binding, verifying-key manifest binding, root expiry ordering, and
forbidden sensitive input fields.

The output is sanitized evidence with `status=validated_offline`.
`staging DB rotate is not satisfied by the offline evidence`; it only proves the
public root material is internally consistent and ready to be passed to the
backend lifecycle boundary.

## Staging / Production Rotate

The actual database change must run inside the backend operational boundary. Use
the .NET ops tool, which validates the same public manifests and then calls
`AnonymousCredentialRootLifecycleService.RotateAsync` through the backend
service graph:

```bash
dotnet run --project tools/security/AnonymousCredentialRootBootstrap/FsusBlog.AnonymousCredentialRootBootstrap.csproj -- \
  --input /secure/ops/anonymous-root-2026q3.json \
  --trusted-setup-manifest security/zk/provenance/comment-v5-trusted-setup.manifest.json \
  --verifying-key-manifest config/zk/anonymous-comment-v5-verifying-key.manifest.json \
  --db-type postgres \
  --connection-string "$FSUSBLOG_ROOT_BOOTSTRAP_CONNECTION_STRING" \
  --evidence .tmp/security/anonymous-credential-root-bootstrap.json
```

For disposable staging smoke runs against SQLite, add `--db-type sqlite
--connection-string "Data Source=/tmp/fsus-root-bootstrap.db" --ensure-schema`.
Do not use `--ensure-schema` against production unless the migration plan
explicitly calls for it.

After rotate, the tool refreshes the runtime root snapshot, requires accepted
root readiness, captures the high-value audit event
`security.anonymous_credential.root_rotated`, and writes sanitized evidence with
`status=rotated` and `stagingDbRotateSatisfied=true`. The evidence does not
include the database connection string, issuer private key, credential secret, or
proof witness.

Verify after rotate:

```bash
node tools/security/check-privacy-zk-prod-release.mjs \
  --config src/backend/appsettings.Production.json \
  --trusted-setup-manifest security/zk/provenance/comment-v5-trusted-setup.manifest.json \
  --smoke-evidence .tmp/security/privacy-zk-prod-smoke.json \
  --root-bootstrap-evidence .tmp/security/anonymous-credential-root-bootstrap.json \
  --require-enabled
```

The release gate checks that root bootstrap evidence is `status=rotated`, has
`stagingDbRotateSatisfied=true`, includes the high-value audit action, and binds
the same `verifyingKeyHash` as production config and the trusted setup manifest.
The real ZK-Prod smoke evidence still has to prove `credentialRootActive=true`
from the runtime root snapshot.

## Rollback

1. Set `AnonymousIdentity:ZkProd:Enabled=false` in the active production
   configuration.
2. Re-run `node tools/security/check-privacy-zk-prod-release.mjs` and confirm
   the disabled safe baseline passes.
3. Mark the active root expired or revoked through the same lifecycle/ops
   boundary, then refresh the runtime root snapshot.
4. 不删除已写入的匿名评论; rollback only disables future ZK-Prod ticket issuance
   and root acceptance.
5. Keep the offline bootstrap evidence, rotate transcript, high-value audit id,
   release gate summary, and smoke evidence in the release record.

## Evidence Boundary

`tools/security/bootstrap-anonymous-credential-root.mjs` is intentionally an
offline validator. Therefore a green `validated_offline` bootstrap evidence file
alone does not fully satisfy staging DB rotate. ZK-Prod release requires the
.NET rotate evidence from
`tools/security/AnonymousCredentialRootBootstrap/FsusBlog.AnonymousCredentialRootBootstrap.csproj`
plus runtime smoke evidence before enabling ZK-Prod.
