# Security atomic consumer and execution contract

This proposed source interface belongs exclusively to #2257, #2259 and #2260.
It consumes canonical fixture, attempt, scheduler and matrix ports. It does not
activate a second matrix, inventory, reset authority or release qualification.
The existing security lane remains active until owner-controlled registration
and real runtime acceptance are complete.

## Exact source consumption

The first increment used actual master `53da546cc8ab9fd8603067395d988b7ddb650394`.
The continuation consumes terminal source
`2eda290cc6098971b685b3fb1465d7193bd3dde2` through merge
`dd6c2b54691c171b6195c93f44cb919464e6e986`, including framework behavior
`653ef38e2ce6dbcf8e2671bd8e091eb9c04538a0`, explicit URL import correction
`ebf0d6e0e555ba8bf64ceb4dbc9de6427cc1699c`, and fetched master
`aaba7b8c84ecfb336c71443e30d9fd82d21fb16d`. Shared incoming files remain
byte-identical to that supplied capability. Global interruption cleanup is now
available; the old absence claim is superseded. The owned ordinary control
checks pending cleanup, exact terminal coverage and retained first cause.

Frozen outcome adapter `d90349112269ad4bdd0925705126912265758dc1` and separator
`9b1455c00389daf6472749f78c22d4a77a37766e` are consumed only at their original
boundaries. Neither qualifies external SDK Compile ownership.

## Projection and admission

`projectSecurityBarriers` consumes the existing fixture DAG and security catalog.
It declares runtime readiness, canonical fixture preparation, reset admission,
legacy-only pre-attack reset and post-gate cleanup. Reset names and postconditions
remain with their existing owners.

`projectSecurityScenarios` projects each original resident application scenario.
Producer IDs use the canonical attempt runner's lowercase hyphen format;
`testId`, scenario source/export, assertions, coverage, identity and fixtures keep
the original catalog identity. Catalog-to-producer collisions are rejected.
Resident and legacy declarations preserve exact-one attempt and zero retries.

`projectSecurityBoundaries` consumes the policy owner's exact four-key projection:
local exposure, firewall evidence, external production exposure and DAST. Explicit
inputs, state access, replay and envelope references remain individually owned.
No ambient environment determines policy applicability. Exclusion still requires
an original policy-bound terminal receipt; missing tools/runtime are not exclusion.

Admission context is exactly `runId`, `namespace`, `profileId`, `sourceRevision`,
`runtimeDigest`, `stateCatalogDigest`. References are exactly `owner`,
`sourceRevision`, `path`, `contentDigest`. A verifier `(reference, context)` must
read the original current-run evidence and return its verified digest. No default
successful verifier exists. Exact source revisions are mandatory; a digest alone
is identity, not authority.

`scenarioDeclaration` and `boundaryDeclaration` additionally bind projected
fields to the canonical catalog, policy and owner inputs. `hostFailureLedger`
verifies every failed host attempt against fresh health/identity/isolation
observations. `terminalProjection` verifies each projected state/reason/failure
set against the original terminal receipt. `collectSecurityTerminals` requires
one receipt per required producer and preserves every primary/cleanup failure.
`materializeSecurityWeightedSteps` emits native hard/settled dependencies,
coordination joins and always-run cleanup only after physical ownership checks.

## Fixture lifecycle

`createSecurityFixtureLifecycle` binds explicit profile and execution identity to
current context, admits runtime readiness, and calls the original orchestrator
`plan`, `prepare`, `verify`, `cleanup`. It uses the existing catalog ports by
default. Preparation, verification and finalization each execute once; a rejected
preparation/finalization cannot restart through this object. Original prepare
rollback state and original verification errors are retained. Cleanup runs under
its separately owned cleanup signal/budget instead of the cancelled producer
signal. A cleanup failure exposes the original canonical error and the first
preparation/verification failure separately. No new receipt is minted.

`admitReset` requires the original reset verifier. Successful fixture cleanup
does not establish current-run reset before/after proof. The canonical security
producer validates its independent cleanup observation internally but discards
that observation at its public cleanup return; the exact receipt export/current
binding capability remains requested from that owner.

## Single-scenario resident dispatch

The additive `createRuntimeScenarioDispatchSession` export in the existing host
reuses its runner loading, environment scoping and shared runtime initialization.
Its existing grouped API is preserved. The new session invokes one original
catalog resident runner per request, initializes once, never performs hidden
resets, and refuses duplicate attempts. Process-global environment mutation is
exclusive across dispatch sessions. Cancellation waits for the actual runner to
settle before restoring globals/releasing the lease. Rejected initialization is
retained without an automatic restart. Original result/error objects stay in the
local observation ledger; this ledger is not a canonical terminal journal.

`createSecurityScenarioDispatchSession` connects this seam to existing security
admission. `resolveReferences({producer, context, hostFailureRefs, signal})`
provides fresh owner references. Every observed failed/cancelled dispatch must be
resolved through `hostAttemptReference(attempt, context)` to an original terminal
journal reference, verified through `terminal`, and covered by the existing
`hostRevalidation`/`hostFailureLedger` admission. A caller cannot omit the session's
failure history. Candidate commit/run and catalog digest must match exactly.

## Independent canonical attempts

`runSecurityScenarioAttempt` consumes an exact compiled DAG/matrix/authority set,
checks its runtime declaration, fixture profile, hard edges and zero-retry policy,
and invokes the existing `runProducerAttempts`. `scenarioExecution(producer,
step, context)` must bind the actual standalone command, input closure, state,
resource and envelope to the original scenario invocation. The caller supplies
no command, retry registry or test enumeration override. Expected test IDs come
from the original sealed replay plan; source/worktree/run/environment and exact
replay artifact bytes must match.

`scenarioGrantIdentity(producer, step, schedulerGrant, context)` binds the
producer to its canonical tier. `schedulerGrant` carries `checkpointFile`,
`tierId`, `ownerToken`, `minimumGeneration`, `expectedGeneration`. Immediately
before spawn the adapter calls the supplied terminal source's actual
`readCanonicalSchedulerCheckpoint` and `readCanonicalSchedulerResourceGrant`.
Immutable checkpoint/journal source identity, active owner, exact generation,
projection equality, unchanged read digest and declared resource minima are
required. The adapter never writes scheduler CAS or seals Production correctness.

`runSecurityBoundaryAttempt` independently admits original policy/evidence and
executes applicable correctness boundaries through those same original ports.
Its additional owner ports are `boundaryExecution` and `boundaryGrantIdentity`.
A policy exclusion returns the admitted non-spawn request with `terminalReceipt`
explicitly null. Diagnostic boundaries refuse correctness execution until the
canonical owner supplies a non-correctness attempt/terminal port. Neither branch
is relabeled success. Original subprocess sidecars and first-attempt receipts
are retained; exit zero without a sidecar remains a canonical runner failure.

## Remaining owner capabilities and acceptance

- #2257: exact current-candidate fixture admission reference and exported reset
  before/after observation with run/namespace/profile/source/runtime/state-domain
  binding; real canonical security-state fixtures and finalizer integration in
  the active lane. Current fixture binding is pending with the sole #3521 owner.
- #2259: matrix-owned standalone resident command/IPC bridge to the shared dispatch
  session; exact scenario-to-inventory test mapping, input closure, state/isolation
  grants, replay/envelopes and journal-reference projection for host failure
  revalidation. The programmatic seam executes real runners but is not an active
  subprocess resident-service transport or lane replacement.
- #2260: canonical conditional/non-applicable and diagnostic terminal/attempt
  support. Supplied atomic v1 accepts correctness executable children only;
  its audit disposition API does not implement a conditional execution state.
  Original exposure/firewall/DAST commands need owner-approved result bridges
  before unchanged exit-zero/no-sidecar paths can be admitted.
- #1686/#1598/#1599 and the integration owner: single-writer matrix/inventory,
  physical ownership, state/resource registration and active-lane replacement.
  Hard prerequisites need their own canonical parent projection; they must not
  silently expand the scenario-only `security-runtime-core` aggregate roster.
  No global registry, scheduler, inventory or retained authority source is edited.

The added tests are ordinary source controls: original-runner injection and auth
fixture transport controls, actual active local run lock/immutable store/grant
read, and actual subprocess success/product-failure/cancellation receipts. Their
synthetic domain facts are not native security runtime or Production acceptance.
Old negative consumer/semantic/cohort audits are not replayed for this increment.
All three issues remain OPEN. Real backend, shared host IPC, physical conflict
admission, legacy/resident parity, Fresh/resume and independent acceptance remain
unrun. Rollback reverts only owned source and its additive host export; credentials,
security settings, runtime resources, publication and release authority are unchanged.
