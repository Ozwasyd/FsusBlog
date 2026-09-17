# Article Rights Proof

Article Rights Proof records bind a public article revision to its frozen Rights V3 snapshot. It proves that the public revision, content canonical hash, rights policy hash, publish proof pointer, site signature, and local transparency log entry agreed at proof time.

It is a local off-chain integrity record. It is not IPFS, Arweave, blockchain anchoring, wallet identity, or external timestamping.

## Durable Row

The durable table is `article_rights_proof`, represented by `ArticleRightsProof`.

The idempotency key is:

```text
article:{articleId}:revision:{articleRevisionId}:rights:{proofVersion}
```

Replaying the same article revision updates the same row instead of inserting duplicates. Historical rows can remain `superseded` and verifiable after a later revision becomes current.

## Canonical Record

`ArticleRightsProofCanonicalPayloadV1` serializes:

- domain separator: `fsusblog.integrity.article-rights-proof-record.v1`
- proof version and signature payload version
- `articleId`
- `articleRevisionId`
- `revisionNo`
- `articleRightsSnapshotId`
- `publishProofId`
- Rights V3 `rightsPolicyHash`
- article `contentCanonicalHash`
- issued timestamp
- low-cardinality proof status

Only `ready` public proofs are signed. The signing payload uses proof kind `article-rights-proof` and the existing site integrity signing key registry.

## Scheduling

Rights proof scheduling runs from the same write/outbox integrity path as publish proof. Public requests do not generate or repair rights proofs.

A ready rights proof requires:

- the article is publicly visible;
- an `ArticleRevision.Id` exists;
- an `article_rights_snapshot` exists for the revision;
- the snapshot has a ready content canonical hash;
- the related publish proof is ready or superseded;
- Rights V3 proof binding remains enabled.

Missing snapshot, pending content hash, or pending publish proof stays `pending`. Draft, scheduled, archived, deleted, or proof-binding-disabled states do not produce ready public rights proof.

## Public Manifests

Public sidecars:

- `/integrity/article/{articleId}/rights`
- `/integrity/article/{articleId}/revisions/{revisionNo}/rights`

Ready and superseded manifests expose only public verification coordinates, hashes, signature, and transparency log pointer. Pending, failed, retrying, not-public, missing, private, hidden, or deleted cases expose only a stable low-sensitive status or public error manifest.

Public manifests must not include admin principal id, IP address, user agent, session id, device id, private drafts, comments, private messages, failure detail, stack traces, tokens, private keys, or secret material.
