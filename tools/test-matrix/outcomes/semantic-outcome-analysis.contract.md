# Semantic outcome analysis boundary

This source contract describes independently testable portions of #2025, #2026
and #2027. The unique field dispositions, schemas, failure taxonomy and producer
catalog remain with their existing owners. No adapter is reimplemented here.

`analyzeStrongSemanticOutcome(value, options, metadata, members)` consumes the
original strong producer or aggregate schema and explicit external contract
digests, semantic expectations and finite host budgets. It verifies the original
content seal before canonicalizing arrays by registry identity. Unknown fields,
missing dispositions, duplicate identities, invalid partitions and unsupported
versions fail closed. Every inclusion/exclusion is registry-driven. Secret
context digests in the strong schema remain semantic; unbridged metadata secrets
retain the original refusal. Registered diagnostic, volatile and location
metadata are excluded from the fingerprint and remain inspectable separately.

The result contains canonical data, semantic payload digest and a version-bound
fingerprint. It always declares `dataOnly: true` and
`producerVerificationPending: true`. Original independent execution, replay,
temporal, attempt, policy and held-input evidence verification is still required.
Neither a matching digest nor a caller's `verified` flag grants that authority.
The existing `sealVerifiedProducerSemanticOutcome` refusal remains unchanged.

`prepareAggregateOutcomeAnalysis(options, members)` requires external exact
required producer IDs, coverage and semantic owner/digest expectations. Members
are original canonical strong-schema data with explicit member expectations and
matching recomputed fingerprints. It retains each original member content digest
and builds exact test/coverage unions, semantic state/artifact unions, failure
topology and status vector. Ambiguous global test ownership and conflicting
semantic owners/digests are refused. The existing aggregate schema expresses
completeness as `complete` or `incomplete`; failed, partial, blocked and cancelled
statuses remain in the member vector and topology. No caller data is mutated.

This aggregate is a data analysis, not a verified run outcome. No checkpoint,
locator, publication, scheduler CAS, crash-window acceptance or terminal receipt
is issued. Those paths require the real independently held producer capability.
Fingerprint/diff data are neither security signatures nor three-run cohort or
release qualification. Roll back this scoped implementation if it rejects a
legitimate original contract, while preserving original failure controls.

The source controls are `tests/tools/strong-outcome-analysis.test.mjs` and
`tests/tools/aggregate-outcome-analysis.test.mjs`. Their support fixture explicitly
creates synthetic DATA_ONLY expectations, never native runtime evidence.
