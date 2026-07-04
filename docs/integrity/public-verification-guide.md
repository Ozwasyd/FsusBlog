# IntegrityProof Public Verification Guide

This guide describes public verification for already published IntegrityProof manifests. Verification is local and offline after the verifier downloads the public JSON files; it does not use IPFS, Arweave, blockchain, wallets, or an external timestamping network.

## Inputs

For an article proof, collect:

- `/integrity/keys.json`
- `/integrity/article/{articleId}` or another public proof route
- optional checkpoint manifest from `/integrity/checkpoints/latest` or `/integrity/checkpoints/{date}`
- optional log head from `/integrity/log/head`
- the public article artifact bytes you want to compare

The proof manifest identifies `articleId`, `articleRevisionId`, and `revisionNo`. Those names are canonical for IntegrityProof public verification.

## Verification Steps

1. Confirm `status` is `ready` or a supported historical `superseded` state.
2. Rebuild the canonical hash for the public article payload.
3. Recompute each artifact digest for PublicAOT, ArticleDetailAeds, PublicHotRead, feed, sitemap, robots, and distribution outputs that are listed by the manifest.
4. Rebuild the publish proof signing payload.
5. Select the `keyId` from `/integrity/keys.json`.
6. Reject unknown, revoked-at-signing-time, compromised, or algorithm-mismatched keys.
7. Verify the `ECDSA_P256_SHA256` signature.
8. Verify the transparency log entry hash and previous hash pointer when the manifest includes log coordinates.
9. Verify the Merkle checkpoint root and inclusion proof when checkpoint data is present.

The same checks are automated by:

```bash
tools/test/lanes/integrity-proof-verification.sh
```

## What To Reject

Reject a manifest when:

- canonical hash differs;
- any artifact digest differs;
- signing algorithm differs from the key metadata;
- key id is unknown;
- signature verification fails;
- transparency log chain has a gap or mismatch;
- Merkle checkpoint root does not match the leaves;
- inclusion proof fails;
- proof status is `pending`, `retrying`, `failed`, `not-public`, `missing`, `private`, or `hidden`.

## Privacy Boundary

The public verification API does not expose draft content, comments, private revisions, user profiles, messages, audit logs, admin attribution, admin principal id, IP address, device fingerprint, session id, token, private key, or raw secret material.

If a public proof appears to expose any of those fields, treat it as a release blocker and report it as private data leakage.
