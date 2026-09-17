# Content Credentials key lifecycle

Content Credentials does not use FsusBlog JWT, Cookie, Passkey, or anonymous-credential keys. Built-in prototype certificates carry no production trust; any `production-default` decision first requires a dedicated signer and C2PA certificate chain. The wider key boundary is in the [security model](../security.md).

## Environment isolation

| Environment | Private-key boundary | Allowed use |
|---|---|---|
| local fixture | `c2patool` built-in test certificate or temporary test key | canonicalization, tamper negatives, tool wiring |
| CI prototype lane | Short-lived test key only; never upload an artifact | Explicit offline interoperability |
| production candidate | External signer/HSM/KMS boundary | Drills and controlled opt-in signing |
| production default | Only after every upgrade gate passes | Approved Content Credentials |

Production private keys never enter the repository, appsettings, container layers, stdout, GitHub Actions artifacts, canonical packages, manifest definitions, or plaintext backups. The application stores only the public certificate chain, key id, version, validity, revocation status, and signing receipt.

## Generation and enablement

1. Generate a C2PA-only key in an isolated signer; do not reuse site TLS, JWT, or integrity-proof keys.
2. Record algorithm, certificate chain, key id, version, not-before/not-after, and custody owner.
3. Sign a fixed fixture and verify it offline with two independent implementation families.
4. Verify that the manifest contains no email, IP, device identifier, internal user id, prompt, private draft, or model log.
5. Publish only the public chain and keep `productionDefault=false` until the upgrade receipt is complete and an operator approves it.

## Rotation

- Keep old and new certificates together; old manifests verify with their signing-time certificate.
- Use the new key only for new revisions; never re-sign or overwrite history.
- Record that old manifests still verify, new manifests use the new key, and static download, cache restore, and redeployment remain consistent.
- Stop old-key signing after the observation window, but retain its public certificate and revocation information.

## Revocation, compromise, and recovery

For suspected private-key compromise:

1. Stop new signatures with that key and switch Content Credentials publishing off; keep body reads available.
2. Publish a timestamped, reason-coded revocation record; retain historical manifests and never fake success or delete evidence.
3. Distinguish pre-revocation credentials from those in the compromise window. The UI uses fixed states `credential_revoked`, `credential_compromised`, `digest_mismatch`, and `manifest_unavailable`; it does not infer malicious body content.
4. Generate a new key and complete dual-verifier, rotation, and recovery drills before restoring opt-in signing.
5. Incident reports contain no private key, complete internal certificate inventory, author identity, or private content.

Backups contain only encrypted signer state, the public certificate catalog, revocation records, and immutable manifests. In an isolated recovery drill, verify least-privilege key access, historical-manifest verification, and that the old key cannot accidentally become the current signer.

## No-restart degradation

Before production wiring, provide an independent runtime switch that immediately disables new signing and page-manifest association. Degradation does not change ordinary article APIs, binary frames, notification streams, login state, or admin permissions. Before restoring signing, reread signer health, certificate status, and upgrade gates; never skip verification fail-open.
