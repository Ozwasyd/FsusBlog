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

The inspected master provides the required-evidence catalog but does not provide the
complete candidate identity verifier, immutable cohort create, atomic ordinal append,
terminal seal or independent ledger verifier required by the candidate cohort contract.
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
