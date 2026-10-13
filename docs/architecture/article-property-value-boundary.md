# Article property value validation boundary

The existing `ArticlePropertyDefinitionContract` remains the sole eight-type catalog and definition-policy owner. Shared `ArticlePropertyTypedValue` payloads, presence, normalized entries and snapshot candidates do not introduce a second catalog or a persistence authority.

`ArticlePropertyValueValidator.ValidateAsync` reads the current canonical definition store and requires its existing permission authority. It validates expected definition ID/schema revision/digest, active status, presence/default/empty policies, the exact typed payload, active option IDs, UTC dates and URL constraints. Nonempty article references require the supplied `IArticlePropertyReferenceValueAuthority` to establish current identity, site, read permission, lifecycle and self/cycle policy. The current unavailable implementation refuses these references; it never treats missing authority as an empty impact or a successful resolution.

`ValidateInputsAsync` supplies the same read-only validation before a new article has a canonical identity. It supports primitive values and empty reference sets. Nonempty references, including defaults, fail with `article_property_reference_source_identity_unavailable` before invoking a reference provider. A package planner must not allocate a database identity or invent a source article ID to pass this check.

Normalized entries retain `Missing`, `Null`, zero, false, empty values and definition-owned normalization. `DefaultApplied` records normalization provenance separately from the value type and participates in the value/snapshot digest. Defaults and explicit identical values therefore remain distinguishable. Inputs and collection payloads are copied before normalization/binding; entries are sorted by stable definition ID.

`BindSnapshot` creates an immutable candidate from genuinely observed article/revision/property and optional draft/publication coordinates. `ValidateSnapshotCandidate` checks its closed schema, coordinate/value shapes and recomputed digests. These pure operations do not prove that coordinates were observed, persist anything, authorize a caller, produce a durable receipt or qualify a PostgreSQL transaction. The sole canonical article transaction must recheck current permissions, definitions and reference policies before a write.

## Remaining integration

Related to #2322, #2323, #2324 and tracking #1808. This increment supplies a zero-write API for the canonical package planner. The current value writer, persistence/CAS/reconciliation, draft/revision/publication storage, production reference authority and canonical query/index projection remain separate, unaccepted capabilities. It adds no route, wire root, database migration or production provider registration. Runtime, HTTP/session, rendered UX and full-chain scale acceptance remain open.
