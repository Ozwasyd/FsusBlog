# Release candidate qualification contracts

`qualification-policy.mjs` owns the fixed three-round policy and derives repeatability
from the existing required-evidence catalog. It does not maintain a second authority
list. All current executable catalog authorities are per-run, including projections,
runtime measurements and finalization. Newly admitted catalog authorities default to
per-run. A candidate-once input is a closed declarative reference to immutable build
or static content; executable commands and mutable-environment operations have no
purity proof here and are refused. Build creation remains with its existing producer.

`qualificationIdentityBinding()` supplies the policy, repeatability, required catalog
and receipt-schema digests to the candidate identity owner. Any change requires a
new cohort. `verifyQualificationPolicy()` and `verifyRepeatabilityCatalog()` reject
both tampering and resealed rule changes, including fewer rounds, concurrency,
manual exceptions, warning states and recovered attempts.

The qualification receipt schema covers the parent contract fields, exact three-round
qualified shape and canonical blocker identifiers. Schema validation is shape checking;
it does not verify candidate identity, ledger custody, current-run receipts, content
digests or producer evidence. A hand-written schema-valid receipt grants no authority.

Run the source-stage controls with the repository's locked schema dependency:

```bash
npm ci --ignore-scripts --prefix tools/test-matrix/schema-validator --cache /tmp/qualification-npm-cache
node --test tests/tools/release-candidate-qualification-policy.test.mjs
```

## Upstream capability boundary

The inspected master provides the required-evidence catalog. Published candidate
identity source is available separately at `4c53ad9216c84d8e39a2524d71d10a60e6b2e141`.
The immutable cohort create, atomic ordinal append, terminal seal and independent
ledger verifier required by the candidate cohort contract remain separate capabilities.
The existing release clean-attempt cohort is a separate build/attempt admission API;
its build digest and event slots do not supply the complete candidate ledger contract.

Qualification execution must consume those upstream APIs through explicit refs and
digests. It must retain failed slots, perform each dynamic authority independently,
wait for complete postflight before starting another ordinal and stop on unsafe
cleanup. A retry requires a new cohort and all three rounds. Until those APIs and
verified aggregate/current-run materials are available, these source contracts do
not create cohorts, run producers, seal qualification or expose publish credentials.
Global matrix registration and local/CI terminal acceptance remain with their owners.

## Planning and comparison material

`prepareQualificationPlanMaterial()` derives exactly three resource namespaces,
disjoint HOME/TMP/cache/runtime roots and bounded port sets. Every ordinal references
the same immutable build, replay, temporal, envelope and fixture inputs. Its required
authority commands, verifier, receipt schema, locator/output keys and required IDs
come directly from the catalog, with each dynamic requirement repeated three times.
Recomputation rejects resealed omissions, resource collisions and per-round replans.
It performs no process launch, resource allocation or runtime write.

This is planning material with `requires-verified-cohort-and-sealed-producer-dag`
admission status. The upstream candidate/ledger verifier and canonical producer DAG
must still admit it and supply exact dependencies, finalizer/outcome ordering and
current-run command bindings. It is not a runnable sealed plan or an isolation proof.
The cohort identity/refs in controlled tests are synthetic contract fixtures.

`compareQualificationSemantics()` consumes exactly three ordered normalized data
records with distinct run IDs. It compares the aggregate fingerprint, semantic state,
semantic artifacts and failure topology exactly, without a majority or last-green
rule. It uses the existing canonical digest function and does not normalize producer
receipts or reinterpret volatile fields. Its output is explicitly `comparisonOnly`;
even equality cannot grant qualification or publish authorization. The independent
verifier must first check the complete candidate ledger, actual aggregate/producer
refs, identity, membership, coverage, cleanup, chronology and attempt eligibility.

```bash
node --test tests/tools/release-candidate-qualification-plan.test.mjs tests/tools/release-candidate-qualification-comparison.test.mjs
```

## Exact upstream consumer contracts

`qualificationCandidateConfigurationDigests()` maps the three qualification digests
to semantic IDs in the existing candidate `configurationDigests` map. Candidate
source `4c53ad9216c84d8e39a2524d71d10a60e6b2e141` already admits this map;
the candidate schema is not extended or copied. The collector must include these
entries before `createCandidateIdentity()`, and the complete upstream
`verifyCandidateIdentity()` must run before `verifyQualificationCandidatePolicyBinding()`.
The latter checks only qualification's policy slice and the required-evidence catalog.
It does not authenticate source facts or replace the complete identity verifier.

`comparisonMaterialFromAggregateAnalysis()` consumes the actual aggregate analysis
shape from `prepareAggregateOutcomeAnalysis()` at
`c2f8586bf09078bb75198e9c777f13a663c14eda`. It preserves the original aggregate
fingerprint and copies semantic-ID/digest arrays into comparison maps. Unknown or
duplicate semantic entries, mismatched fingerprints and attempted promotion of
`dataOnly`/`producerVerificationPending` are refused. Semantic ownership stays in
the upstream fingerprint. Extraction performs no receipt normalization or independent
producer verification. The complete externally expected analyzer must run first.

Both source capabilities are usable while their issues remain open. The aggregate
API is explicitly DATA_ONLY and still needs held-input producer authority and
current-run checkpoint/CAS publication. Neither source contract supplies the missing
cohort custody API or grants runtime, qualification or publish acceptance. Qualification
documentation lives here to avoid concurrent edits to the identity owner's umbrella README.
