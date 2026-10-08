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
