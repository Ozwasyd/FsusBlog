# Canonical hash test ownership

Article content and Article Rights canonical hashing use four distinct evidence layers. A failure should identify one contract, invariant, or architecture boundary rather than expose an implementation fragment as if it were product behavior.

## Evidence layers

| Layer | Authoritative owner | Responsibility |
| --- | --- | --- |
| Golden vectors | `tests/backend/Fixtures/canonical-hash-golden-vectors.json` | Complete canonical payload bytes and digest for every supported public canonical version. Existing vectors are immutable; a new version adds a vector instead of rewriting v1. |
| Product behavior | `ArticleCanonicalHashTests` and `ArticleRightsCanonicalHashTests` | Newline and Unicode normalization, set ordering, null/empty distinction, domain/version separation, and one independently discoverable mutation case per bound field. |
| Manifest compatibility | `IntegrityVerificationManifestServiceTests` | Ready and superseded manifests retain their canonical hashes; failed or non-public responses do not disclose them. |
| Source governance | `CanonicalHashSourceGovernanceTests` | Core project dependencies, forbidden runtime namespaces, buffer-writer architecture, and separation of behavior tests from runtime/payload shape assertions. |

The machine-readable owner map is `tests/backend/Fixtures/canonical-hash-test-ownership.json`. It links each canonical contract to its golden, behavior, manifest, and governance owners. Test-ID renames or merges are recorded in `tests/test-retention-replacements.json` and must pass the repository retention audit.

## Stable case identity

Theory rows use semantic strings such as `crlf-lf`, `unicode-nfc`, `tag-set-order-and-duplicates`, and the canonical input property name. Each field mutation therefore remains a separately discoverable xUnit case with a field-specific failure message. No loop hides multiple mutations behind one test result.

Golden assertions compare the entire payload byte sequence and digest. Product behavior tests intentionally avoid `Contains` assertions against serialized line fragments. Source and assembly boundaries intentionally stay out of the product behavior classes.

## Compatibility policy

`ArticleCanonicalHashV1` and `ArticleRightsCanonicalHashV1` remain unchanged. This test refactor does not change domains, versions, field binding, normalization, sorting, null encoding, hash prefix semantics, or manifest projection. A future canonical version must:

1. keep all prior vectors executable;
2. add one minimal complete vector for the new version;
3. add semantic behavior rows for new or changed invariants;
4. update the owner map and retention replacement ledger when test IDs move.
