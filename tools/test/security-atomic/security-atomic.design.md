# Security atomic projection consumer contract

This proposed source interface belongs only to issues #2257, #2259 and #2260.
It is an independently testable consumer increment, not a second scheduler,
matrix, fixture/reset authority, attempt runner or runtime acceptance receipt.
The existing lane is still authoritative for execution until the original owners
provide the missing compiler and integration capabilities below.

`projectSecurityBarriers` reads the canonical runtime scenario catalog and calls
the existing `buildProducerDag` for the selected non-empty fixture profile. It
emits readiness, fixture lifecycle references, consumed reset barriers, and a
post-gate cleanup declaration. The legacy pre-attack node exists only when the
catalog contains its consumer. Reset barrier names remain the original catalog
names; this module neither runs reset commands nor declares postconditions.

`projectSecurityScenarios` emits one producer per application scenario from
`config/testing/runtime-scenario-catalog.json`. External exposure and DAST stay
with the fixed #2260 boundary set. An unknown retained application scenario
fails projection instead of disappearing. Scenario source, export, identity,
fixture, assertions and coverage are preserved. Both modes share producer/test
IDs, attempt number one and zero retries. Their invocation is a catalog dispatch
request, not a newly invented shell command. State access, isolation, replay and
execution envelope references must cover the catalog exactly once. Reusing an
isolation reference across scenarios fails closed; actual account/device/session
and namespace isolation must still be verified by the canonical state owner.

`projectSecurityBoundaries` consumes a verified policy-owner reference and its
closed projection, with exactly the four external producer identities. No ambient
environment controls applicability. An applicable firewall requires explicit
evidence inputs; live exposure requires explicit policy inputs. Local exposure
and DAST preserve their existing catalog invocation. Firewall and external
exposure request the existing boundary owner, including all required evidence
verification; no new scanner, warning policy or shell fallback is introduced.
Every producer keeps its own state-access, envelope and replay reference.

Admission functions return sealed requests only after all required canonical
owner ports accept their current-run references. They do not spawn, acquire
grants, execute attempts, seal terminal receipts or qualify Production. There
are no default successful verifiers. A body digest is identity, not authority.
Every verifier must read the exact referenced evidence and enforce run, namespace,
profile, candidate source, runtime identity and state catalog binding. An owner
source revision may differ from the candidate revision; it must be the exact
reviewed implementation used by the caller. `sourceRevision` cannot be `latest`.

The required ports are `runtime`, `fixture`, `reset`, `stateAccess`, `isolation`,
`replay`, `envelope`, `host`, `hostRevalidation`, `boundaryPolicy`, `boundaryInput`
and `terminal`. Each receives `(reference, context)` and returns the verified
reference digest, or throws. The context has exactly `runId`, `namespace`,
`profileId`, `sourceRevision`, `runtimeDigest` and `stateCatalogDigest`.
References have exactly `owner`, `sourceRevision`, `path` and `contentDigest`.
These are consumer API bindings; they do not replace any upstream receipt schema.

Additional owner ports verify projected fields against actual canonical evidence:

- `scenarioDeclaration(producer, context)` checks exact catalog membership,
  prerequisites, source invocation and all per-scenario owner bindings, returning
  the producer ID. `host(reference, context)` must check the current failure
  ledger independently, even if the caller supplies an empty failure list.
- `hostFailureLedger(failureRefs, revalidationRef, context)` accepts only a fresh
  health/identity/isolation observation covering every failed host attempt. It
  returns the revalidation digest. A crash or contamination must block admission;
  neither this consumer nor its caller may restart/retry to erase the failure.
- `boundaryPolicyProjection(reference, context)` returns the canonical policy's
  four-key selection. Each entry contains exactly `applicable`, `reasonCode`,
  `classification`, `explicitInputs`, `envelope`, `replay` and `stateAccess`.
  `boundaryDeclaration(producer, selection, context)` verifies the entire request
  against that policy, canonical catalog, required prerequisite graph and owner
  dispatch, returning its producer ID. Missing runtime/evidence/tool availability
  is failure, never policy exclusion. A non-applicable request still obligates
  the compiler to produce a policy-bound terminal receipt without spawning.
- `terminalProjection(item, context)` checks producer ID, terminal state, reason
  and primary failure references against the owner-verified terminal receipt,
  returning its digest. `collectSecurityTerminals` requires exact-one receipt for
  every required producer, keeps every failure including cleanup failure, and
  treats blocked, cancelled, timeout and diagnostic as non-success. It observes
  receipts only; it never executes child commands.

## Missing integration capabilities and preserved acceptance

Actual fetched master for this increment is
`53da546cc8ab9fd8603067395d988b7ddb650394`. Its actual weighted DAG in `tools/test/bundles/bundle-steps.mjs` already has
hard/settled dependencies, coordination joins, terminal validation and finalizer
declarations. The missing capability is security atomic declaration/attempt
integration and exact-one per-scenario host dispatch. The simplified
`step-dag.mjs` is not the weighted API; an earlier absence claim was corrected
in coordinator comment 6053132868. No production adapters are invented here.
Controlled test verifier ports establish only consumer refusal/projection behavior.

- #2248/#2247: provide exact commit/API for declaration compilation, hard versus
  settled edges, always-run finalizers on failure/timeout/cancel, independent
  attempts, replay binding, terminal verification and local/CI/resume DAG identity.
- #2055/#2056/#1995: provide exact fixture lifecycle admission reference and reset
  verifier with real before/after observations, state-domain binding and unchanged
  postconditions. Existing fixture DAG/receipt source APIs are reusable, but this
  increment does not claim scheduler lifecycle integration or runtime reset proof.
- #1598/#1599: register per-scenario isolation/access grants and boundary network
  conflicts through the canonical state catalog. This source does not execute
  concurrent producers or prove conflict enforcement.
- Resident host owner: provide exact-once shared service/lease with one-scenario
  dispatch and authoritative failure-ledger revalidation. Existing host performs
  grouped scenarios and hidden resets; calling it once per producer is prohibited.
- #1686 and original integration owner: register these declarations/tests through
  the canonical matrix/inventory/lifecycle producers. Resolve the existing
  non-catalog auth-broadcast check's physical ownership separately, preserving it.
- Shared lane owner: supply a narrow deletion/dispatch patch for
  `RunSecurityRuntimeCoreOnly` and bundle wiring after these capabilities are
  usable. `_suite-support.sh` overlaps active PR3733; matrix/registry, scheduler,
  canonical inventory/history and original authority files remain untouched.

`materializeSecurityWeightedSteps` verifies matching catalog/mode/profile/context
and exact physical ownership, then produces native `id`, `dependsOn`,
`settledDependsOn`, `runAfterSettled` and `alwaysRunFinalizer` fields. It does not
execute the DAG. Controlled integration tests call the existing
`executeWeightedStepDag` directly and prove sibling continuation, dependent
blocking, complete joins and cleanup after producer failure/timeout/cancellation.
The existing weighted scheduler exits on a global capacity-signal abort before
pending finalizers; global interruption cleanup remains an upstream capability
gap, distinct from per-producer cancellation. This source does not repair the
shared scheduler or map a policy exclusion into a fake successful terminal.

The supplied frozen outcome adapter commit
`d90349112269ad4bdd0925705126912265758dc1` was fetched and inspected; it owns
immutable-build/release-projection/release-finalizer semantic adapters and is not
a security scenario dispatcher. No adapter repair is duplicated. Separator
`9b1455c00389daf6472749f78c22d4a77a37766e` was also fetched and inspected; it
does not establish external SDK Compile ownership and is outside this source
consumer increment.

All three assigned issues remain OPEN. Hidden lane paths are not removed while
their replacement cannot execute. Real runtime evidence, cleanup execution under
all terminal causes, host lease exact-once proof, matrix/inventory exactness,
physical conflict enforcement and final independent acceptance remain unmet.
Rollback is removal of this isolated source increment; no runtime or authority
settings change. No package publication, deployment, issue closure or merge occurs.
