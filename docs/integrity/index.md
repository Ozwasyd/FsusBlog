# IntegrityProof

IntegrityProof is FsusBlog's local, off-chain proof system for public article publication artifacts. It records the relationship between canonical article content, generated public artifacts, a site signature, a local transparency log, and signed Merkle checkpoints.

It is intentionally boring infrastructure:

- single-process Kestrel application boundary;
- PostgreSQL durable rows for proof, log, and checkpoint state;
- Redis remains a runtime cache dependency, not proof storage;
- C#/.NET 10 is the main implementation surface;
- PublicAOT, ArticleDetailAeds, PublicHotRead, feed, sitemap, robots, and distribution outputs are treated as artifact inputs;
- no IPFS, no Arweave, no blockchain anchoring, no wallet flow, and no external consensus.

## What It Proves

A valid proof can show:

- the public content payload for an `articleId`, `articleRevisionId`, and `revisionNo` produced the expected canonical hash;
- the named public artifacts produced the expected artifact digest values;
- the configured site signing key signed the publish proof payload;
- the configured site signing key signed the Rights V3 proof payload when a rights proof is present;
- the proof appeared in the local transparency log;
- the log entry is included in a signed local Merkle checkpoint.

## What It Does Not Prove

IntegrityProof does not prove that:

- PostgreSQL or Redis can never be compromised;
- user privacy is protected by the proof itself;
- XSS, SQL injection, moderation bypass, or comment quality issues do not exist;
- admin users behaved correctly;
- the data is stored forever;
- any chain, IPFS, Arweave, wallet, or external timestamping system accepted the data.

It is not a performance optimization and not a privacy system. It is also not a substitute for authorization, audit logging, backups, moderation, or vulnerability testing.

## Documents

- [Threat Model](threat-model.md) (`docs/integrity/threat-model.md`)
- [Operator Runbook](runbook.md) (`docs/integrity/runbook.md`)
- [Developer Implementation Notes](implementation-notes.md) (`docs/integrity/implementation-notes.md`)
- [Public Verification Guide](public-verification-guide.md) (`docs/integrity/public-verification-guide.md`)
- [Article Rights Canonical Hash](article-rights-canonical-hash.md)
- [Article Rights Proof](article-rights-proof.md)
- [Publish Proof](publish-proof.md)
- [Transparency Log](transparency-log.md)
- [Merkle Checkpoint](merkle-checkpoint.md)
- [Site Integrity Signing Keys](site-signing-keys.md)
- [Admin Integrity Console](admin-console.md)
- [Verification Gate](verification.md)

## Data Boundary

Public proof fields are limited to public content coordinates and proof metadata: `articleId`, `articleRevisionId`, `revisionNo`, canonical hash, rights policy hash, artifact digest values, signing key metadata, transparency log coordinates, and checkpoint coordinates.

Do not include admin principal id, audit log context, private drafts, private messages, comments, user profiles, IP addresses, user agents, session ids, device fingerprints, tokens, private keys, or raw secret material in proof payloads or public manifests.
