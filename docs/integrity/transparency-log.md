# Transparency Log

FsusBlog transparency log is a local append-only hash chain for publish proof history. It improves local auditability of proof creation and checkpointing; it is not a blockchain, not external consensus, and not an IPFS or Arweave publication path.

## Entry Model

Entries are stored in `integrity_transparency_log`.

Core fields:

- `seq`: monotonically increasing local sequence number.
- `entry_type`: currently `publish-proof`; checkpoint entries can be added later.
- `proof_id`: linked `article_publish_proof.id` when the entry records a publish proof.
- `article_id`, `article_revision_id`, `revision_no`: article coordinates copied from the proof.
- `entry_payload_hash`: SHA-256 digest of the proof payload snapshot.
- `prev_entry_hash`: previous entry hash, or the all-zero genesis hash for `seq=1`.
- `entry_hash`: SHA-256 digest of the canonical entry payload.
- `created_at`: UTC append time.
- `signing_key_id`, `signature`: site signing metadata copied from the proof when present.

`article_publish_proof.transparency_log_entry_id` and `article_publish_proof.transparency_log_entry_hash` provide the reverse pointer from proof to log entry.

## Append Semantics

Append uses a database transaction and `pg_advisory_xact_lock(hashtext('integrity_transparency_log'))` so one writer computes the next head at a time. Database constraints enforce unique `seq`, unique `entry_hash`, and one `publish-proof` entry per proof id. Retrying the same proof append returns the existing entry and refreshes the proof back-reference instead of adding a duplicate row.

The chain is local. It can prove that local rows were not silently deleted, modified, or reordered after the fact, assuming the database and configured signing keys remain under site control. It does not prove public timestamping or external consensus.

## Verification

`TransparencyLogChainVerifier` validates entries ordered by `seq`:

- sequence must start at `1` and remain contiguous;
- rows must be in increasing order;
- each `prev_entry_hash` must equal the previous row's `entry_hash`;
- each `entry_hash` must match the canonical payload for that row.

Operations can verify the current chain by running the server-side transparency log verifier over `integrity_transparency_log` ordered by `seq`. The latest head is the row with the greatest `seq`; daily head checks use the greatest `seq` whose `created_at` falls inside the UTC day.

## Boundaries

Transparency log is only for publish proof and integrity checkpoint history. It must not replace `audit_log`, security risk events, comment moderation audit, user behavior logs, or admin attribution. It stores article/proof coordinates and proof signing metadata, not admin principal ids or private audit context.

No part of the first implementation calls blockchain, external transparency services, IPFS, Arweave, or wallet libraries.
