# Merkle Checkpoint

Merkle checkpoint groups a bounded slice of `integrity_transparency_log` entries into a signed local snapshot. It lets an operator or later verifier prove that a publish proof entry was included in a daily or release checkpoint without replaying every log row in the UI path.

It is not blockchain consensus, not public timestamping, and not an IPFS, Arweave, or external transparency service integration.

## Scope

Supported checkpoint kinds:

- `daily`: one UTC-day slice, keyed by date such as `2026-07-04`.
- `release`: a release or deployment slice, keyed by a release identifier.

The checkpoint stores `root_hash`, seq bounds, entry count, bound transparency log head, canonical manifest, and site integrity signature in `integrity_merkle_checkpoint`. Leaf rows are rebuilt from `integrity_transparency_log`; they are not copied into a second persistence table.

## Leaf Encoding

Each leaf uses the domain separator `fsusblog.integrity.merkle-leaf.v1` and binds:

- `seq`
- `entry_hash` from the transparency log
- `proof_id`
- `article_id`
- `article_revision_id`
- `revision_no`

The default build order is ascending `seq`. Rebuilding the same entry set with that order must produce the same root. Preserving an arbitrary caller order is only used by tests to prove that order changes affect the root.

Empty checkpoints use the stable empty-root domain separator `fsusblog.integrity.merkle-empty.v1`. They have `from_seq=0`, `to_seq=0`, `entry_count=0`, and no inclusion proof.

## Inclusion Proof

`MerkleCheckpointBuilder.BuildInclusionProof` returns the selected leaf hash and sibling path. Verification recomputes parent nodes with `fsusblog.integrity.merkle-node.v1` and compares the final value with the checkpoint `root_hash`.

Verification must fail if the leaf hash, sibling path, or root hash is changed.

## Manifest And Signature

The manifest binds:

- checkpoint kind and scope key
- Merkle root
- seq range and entry count
- transparency log head seq and head hash
- creation timestamp

The signature payload uses `ProofKind=merkle-checkpoint` and the site integrity signing key. The payload digest is the SHA-256 digest of the canonical manifest. The bound log head prevents a checkpoint from claiming a root for entries beyond the recorded transparency log head.

## Boundaries

Merkle checkpoint is a batch-verification layer over the local transparency log. It does not replace:

- publish proof artifact signing
- release artifact signing
- SBOM hardening
- audit log or security event storage
- external notarization, timestamping, or consensus

Release evidence can reference a checkpoint manifest, but the checkpoint itself remains a local signed data structure.
