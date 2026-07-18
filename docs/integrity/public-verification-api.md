# Public Verification API

The public verification API exposes signed integrity manifests as ordinary JSON sidecar documents. These endpoints are stable public distribution outputs like feeds or sitemap files. They are not part of the `/api/binary/**` AEDS runtime API, and external verifiers do not need an experimental AEDS frame decoder.

## Endpoints

| Method | Path | Purpose | Cache |
| -------- | ------ | --------- | ------- |
| GET | `/integrity/keys.json` | Public site signing key registry. | `public, max-age=60, stale-while-revalidate=300` |
| GET | `/integrity/article/{articleId}` | Current public publish proof for an article. | ready or superseded proofs are immutable; non-ready states use `no-store` |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}` | Publish proof for one public article revision number. | same as article proof |
| GET | `/integrity/article/{articleId}/rights` | Current public Rights V3 proof for an article. | ready or superseded proofs are immutable; non-ready states use `no-store` |
| GET | `/integrity/article/{articleId}/revisions/{revisionNo}/rights` | Rights V3 proof for one public article revision number. | same as article proof |
| GET | `/integrity/revisions/{articleRevisionId}` | Publish proof by persisted `ArticleRevision.Id`. | same as article proof |
| GET | `/integrity/checkpoints/latest` | Latest signed Merkle checkpoint. | short public manifest cache |
| GET | `/integrity/checkpoints/{date}` | Daily checkpoint for `yyyy-MM-dd`. | short public manifest cache |
| GET | `/integrity/log/head` | Current local transparency log head. | short public manifest cache |

All responses are `application/json; charset=utf-8`. Missing manifests return a stable JSON error with no stack trace or internal exception text. Invalid checkpoint dates return a stable `integrity_manifest_invalid_date` error.

## Publish Proof Manifest

A ready or superseded proof contains:

- `manifestVersion`
- `kind=article-publish-proof`
- low-sensitive `status`
- `proofVersion`
- `hashAlgorithm=sha256`
- `articleId`
- `articleRevisionId`
- `revisionNo`
- `canonicalHash`
- artifact digests for AOT, article detail AEDS, PublicHotRead, asset manifest, and feed output
- signing key id, key version, algorithm, and Base64Url signature
- transparency log pointer

Pending, failed, retrying, and not-public states expose only the low-sensitive status and revision identifiers. They do not expose failure details, stack traces, admin principal context, private drafts, comments, user data, IP, device, session, token, or private key material.

The service only reads already generated proof rows and checkpoints. It does not generate proofs, rebuild artifacts, or call external anchoring systems.

## Rights Proof Manifest

A ready or superseded Rights V3 proof contains:

- `manifestVersion`
- `kind=article-rights-proof`
- low-sensitive `status`
- `proofVersion`
- `hashAlgorithm=sha256`
- `articleId`
- `articleRevisionId`
- `revisionNo`
- `articleRightsSnapshotId`
- `publishProofId`
- `rightsPolicyHash`
- `contentCanonicalHash`
- signing key id, key version, algorithm, and Base64Url signature
- transparency log pointer

Pending, failed, retrying, and not-public Rights V3 states expose only low-sensitive status and coordinates. They do not expose failure details, stack traces, admin principal context, private drafts, comments, user data, IP, user agent, device, session, token, or private key material.

## Key Registry

`/integrity/keys.json` exposes public key metadata needed to verify signatures:

- current key id
- public key id
- algorithm
- optional key version
- public SubjectPublicKeyInfo material
- revocation or compromise markers if configured

Private key fields are never serialized.

## Manual Verification

1. Fetch `/integrity/keys.json` and select the `keyId` from the proof signature.
2. Convert the Base64Url public key to DER SubjectPublicKeyInfo.
3. Rebuild the canonical signing payload described in [Publish Proof](publish-proof.md), [Article Rights Proof](article-rights-proof.md), or [Merkle Checkpoint](merkle-checkpoint.md).
4. Decode the Base64Url signature.
5. Verify the payload digest:

```bash
openssl dgst -sha256 -verify site-key.spki.pem -signature proof.sig proof-signing-payload.txt
```

For publish proofs, the payload subject is `article:{articleId}:revision:{articleRevisionId}` and includes `revisionNo`. For Rights V3 proofs, the payload subject is `article:{articleId}:revision:{articleRevisionId}:rights:{articleRightsSnapshotId}` and includes `publishProofId`. For checkpoints, the payload subject is `checkpoint:{checkpointKind}:{scopeKey}`.

## Boundary

This API is for independent verification of public publish artifacts. It does not expose draft content, private revisions, comments, user profiles, messages, audit logs, admin attribution, IP addresses, device fingerprints, sessions, tokens, or private keys. It also does not use IPFS, Arweave, blockchain writes, or any other external chain.
