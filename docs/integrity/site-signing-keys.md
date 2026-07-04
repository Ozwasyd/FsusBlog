# Site Integrity Signing Keys

FsusBlog site integrity signatures prove that the server accepted a publish proof or checkpoint payload. They do not prove wallet ownership, user identity, SIWE/ENS identity, or chain anchoring.

## Algorithm

Version 1 uses .NET built-in `ECDsa` with the NIST P-256 curve and SHA-256:

- algorithm id: `ECDSA_P256_SHA256`
- payload domain separator: `fsusblog.integrity.publish-proof.v1`
- signature encoding: Base64Url
- public key encoding: Base64Url SubjectPublicKeyInfo
- private key encoding: Base64Url PKCS#8

Ed25519 is not the current built-in scheme. If a future release chooses Ed25519, it must add and review an explicit dependency before changing the algorithm id.

## Key Registry

`SiteSigningKeyRegistry` holds public metadata for all verification keys and one current signing key id. Public metadata includes:

- `keyId`
- `version`
- `algorithm`
- `notBeforeUtc`
- `notAfterUtc`
- `revokedAtUtc`
- `compromisedAtUtc`
- public key SubjectPublicKeyInfo

The public registry never exposes private key material. `PrivateKeyAvailable` is always false on `SiteSigningKeyMetadata`.

## Private Key Sources

Private keys must come from controlled server-side sources only:

- environment variables
- mounted secret volumes
- deployment secret managers surfaced as configuration

Private keys must not be committed to the repository, sent to the browser, embedded in public manifests, managed by C++/Wasm, or logged. Missing production signing configuration evaluates to `Pending` or `Disabled`; the server must not generate fake signatures.

## Rotation

Rotation keeps old public keys for historical verification:

1. Add the new key metadata and private key to server configuration.
2. Set `IntegrityProof:Signing:CurrentKeyId` to the new key id.
3. New proofs are signed with the new key.
4. Old proofs continue to verify against the old public key when their payload `issuedAtUtc` is inside the old key validity window and the old key is not compromised.
5. After the retention window, set `notAfterUtc` for old keys and remove only private material first.

## Revocation And Compromise

`revokedAtUtc` and `compromisedAtUtc` have different semantics:

- Revoked keys cannot sign new proofs at or after `revokedAtUtc`.
- Historical signatures before `revokedAtUtc` may still verify.
- Compromised keys reject verification for all signatures because private-key exposure invalidates trust.

After a private key leak:

1. Mark the key `compromisedAtUtc`.
2. Remove the private key from all secret sources.
3. Rotate `CurrentKeyId` to a clean key.
4. Rebuild affected publish proofs or checkpoints where policy requires fresh trust.
5. Preserve audit evidence without logging the leaked key or raw sensitive payload material.

## Payload

`SiteIntegritySigningPayloadCanonicalizer` serializes payloads with:

- fixed domain separator and payload version
- UTF-8 encoding
- Unicode NFC text normalization
- UTC timestamps with seven fractional digits
- sorted extension fields
- lower-case SHA-256 digest fields

Any payload field change, algorithm mismatch, unknown key id, key state failure, or signature byte change must reject verification.
