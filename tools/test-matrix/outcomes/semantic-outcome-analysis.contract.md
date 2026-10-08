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

`diffSemanticOutcomeData(left, right)` validates both strong inputs and recomputes
their claimed semantic payload/fingerprint. Each side explicitly supplies outcome,
external contract options, metadata and aggregate members. Unsupported/different
schema, algorithm or registry versions report `versionMismatch`,
`inputsValidated: false` and `semanticDrift: null`; they are never directly equal.
Compatible valid inputs emit the eleven fixed difference domains with canonical
paths, member/assertion identities, left/right presence and values, and exact
source refs. Aggregate producer fingerprint/ref changes appear in the artifact
evidence domain; its status vector and failure topology remain separately visible.

`volatileOnlyChanges` contains only registry-declared volatile fields. Diagnostic
and evidence-location differences use `nonSemanticChanges` and cannot be promoted
to volatile. Unknown metadata or new semantic fields fail closed. The five source
mutants in `tests/tools/semantic-outcome-diff.test.mjs` independently replace the
real fingerprint/diff expression with status-only, raw JSON, unknown-ignore,
failed-IDs-only and message-based implementations; the original controls must
reject every imported mutant. This is source testing, not a terminal receipt.

The read-only CLI is `node tools/test-matrix/outcomes/semantic-outcome-diff.mjs`.
Every argument is mandatory: `--root`, `--left`, `--left-digest`, `--right`,
`--right-digest`, `--max-bytes`, `--max-depth`, `--max-nodes`,
`--max-string-bytes`, `--max-array-items`, `--max-object-keys`. Digests use the
`sha256:` prefix. Each path names one exact JSON comparison-side object relative
to the root, with no aliases, selection patterns, scans or fallback. The CLI
holds regular files, verifies their bytes against the supplied digest and reads
within the external byte limit. Side/member host budgets must match the CLI's
independent limits; payload budgets cannot override the host. Exit 0 means valid
data has no semantic drift, 1 means semantic drift, and 2 means version mismatch
or input rejection. These exits grant no current-run locator binding or runtime
acceptance. Use the original #1604 registry/locator/publication capability for
actual producer receipts after the missing verified-producer bridge is supplied.

Constructed-object admission enumerates own keys to reject hidden fields and
symbols; this does not guarantee an allocation bound against arbitrary extra
properties. CLI encoded bytes are independently bounded before JSON parsing.

`analyzeDomainProducerSemanticOutcomeCandidate(candidate, options)` consumes the
original #2020 adapter catalog, membership schemas and
`validateOutcomeAdapterCandidateData` API from exact source
`3f6f443ac4e253f7a9b80e7c7c910d2de8fce824` (PR #3998). It requires externally
held identity, producer, authority, adapter source commit/digest, raw candidate
digest, encoded byte budget and JSON host budgets. Those contracts must be
integrated before using this API; absent contracts are an unmet dependency.

The separate DATA_ONLY fingerprint is version-bound to the catalog, complete
membership schema and exact adapter source. Canonical output preserves every
admitted field, including scoped failure evidence, optional browser members,
frontend suite/test maps and reliability lifecycle order. Schema-declared ID
sets and domain record collections sort deterministically. Candidate and
membership derived seals remain in canonical output and are excluded from this
API's semantic payload; source references and admitted diagnostic evidence are
retained conservatively. This fingerprint is not interchangeable with the
existing v2 producer analysis or the strong outcome fingerprint.

`normalizeScopedOutcomeReasons` consumes the owner's closed failure shape and
original taxonomy, preserving test/case/assertion/project/browser/scenario/action
scope and allowed evidence fields. Existing v2 analysis calls it for richer
reasons while keeping legacy exact reasons intact. `normalizeOutcomeIdsMap`
implements the `ids-map` normalization capability; admission of that new rule
and frontend v2 field profiles remains with the original registry owner. No
registry is modified here. The current contract also provides
`verifyOutcomeInputCustody(encodedCandidate, encodedExpected, options)` through
the original file-backed locator/publication/attempt owners. Its host must supply
the exact physical input mapping, independently pinned context/registry/aggregate,
byte budget and real execution-owner `verifyAuthority` callback. A custody result
retains `producerVerificationPending: true` and `qualificationEligible: false`;
it is not a producer seal or actual runtime acceptance. This normalization API
does not issue or substitute that callback. Producer verification, secret context
and verified current-run aggregate publication remain unmet runtime conditions.
