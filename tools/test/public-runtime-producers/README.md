# Public runtime producer source contracts

This module owns source-stage declarations, canonical compiler/attempt binding,
reset postflight adaptation and a read-only settled projection for
[release-public](https://github.com/Ozwasyd/FsusBlog/issues/2255),
[resilience](https://github.com/Ozwasyd/FsusBlog/issues/2262), and
[load](https://github.com/Ozwasyd/FsusBlog/issues/2264). Its outputs explicitly carry
`qualificationEligible: false`; declaration and projection outputs also carry
`authority: DATA_ONLY`. They cannot independently admit a
process, verify a runtime postcondition, seal a correctness attempt, or qualify a
release. Integration remains proposed until the canonical owners supply those
capabilities.

## Declaration API

`buildPublicRuntimeDeclarations(tier, { root })` returns deterministic source
bindings, child declarations, external dependency slots, and the settled summary.
`verifyPublicRuntimeDeclarations(document, { root })` reconstructs the declaration
from held repository sources and rejects altered commands, membership, edges,
policies, source bindings, or invented reader classification, even after resealing.
The default root is the module's repository, never the ambient working directory.

Release preserves the nine original commands, their backend/preview roles, the
release timeout profile, and governance environment. Every reader depends on the
sole `release-public-hydration` barrier. Resilience derives all six executable
scenarios directly from `runtime-scenario-catalog.json`, including the live
notification recheck; the fixture-only pollution control remains outside runtime.
The existing scenario IDs, fixture labels, reset names, assertions, coverage IDs,
modules/exports, and evidence paths remain intact. There is no new scenario runner.

Load preserves `RunInClientMeasurement`, both npm commands and noise paths. Its
reset has `settledDependsOn: load-public-api`; the second measurement has an
ordinary dependency on the verified reset. The summary settles both windows and
the reset. No declaration changes concurrency, rounds, duration or thresholds.

`verifyPublicRuntimeCommandParity(tier, suiteText, nodes)` checks only original
release/load command membership and arguments. It does not infer dependency edges
from shell order. Unexpected commands or changed arguments fail closed. At the
canonical shell cutover, this migration proof must be replaced in this owned module
with the exact compiler command contract; removing the original functions alone
will intentionally fail this source-stage proof.

All `stateAccessRef` slots are unresolved. They are not read-only grants. Resilience
mutation ordering, fixture verification, reset readiness and host-health edges
must come from the existing state/fixture authorities before execution compilation.

## Projection API

`projectPublicRuntimeOutcomes({ declarations, identity, inputs }, { root })` accepts
an explicit exact set of held DATA_ONLY terminal materials. It performs no file
search. Each input is `{ ref, contentDigest, document }`; the digest covers the
whole document. Refs must name `runs/<current-run>/...` and cannot use `latest`,
traversal, or another run. Identity binds source commit/fingerprint, candidate,
build, manifest, runtime, backend URL and preview URL.

A terminal material records the existing scheduler terminal receipt, attempt,
fixture/state/replay refs, all artifact/evidence refs, failure kind and optional
reset postcondition or measurement material. Executed correctness children require
an individual attempt ref. Blocked children have no correctness attempt. Reset
success requires an explicit postcondition ref. Measurement material separately
binds each window's admission/noise refs, runtime, fixture and quiescence refs, and
monotonic interval. Overlap and cross-window admission/noise reuse are rejected.
Infrastructure failures or cancellation before measurement retain explicit absent
measurement material; success and product outcomes require window evidence.
Projection outputs snapshot the supplied materials without retaining mutable aliases.

The projection preserves every child outcome and separates product, reset,
infrastructure, state-corruption, blocked and cancelled outcomes. Overall status
comes from the existing `buildSettledPhaseJoinEvidence` API. A later success cannot
erase an earlier failure. `verifyPublicRuntimeProjection(projection, heldInputs)`
recomputes the complete output from the exact held inputs and catches tampering.
Input digests and non-null refs prove consistency only: they do not verify the
referenced authority bodies, attempts, lease health or postconditions. Their
independent canonical verification is a mandatory integration prerequisite.

## Required integration contracts

- Atomic compiler/attempt source now exists and is consumed through the adapter
  below. Integration owners (#2248/#2009/#2010) still must supply real matrix-owned
  attachments, complete input closures, fixture/state/resource/replay references,
  runtime verification and immutable terminal inputs. The current runner still
  refuses native exit-zero lane commands without result sidecars; no sidecar is
  fabricated for those commands here.
- State owners (#1598/#1599) must resolve each child's access proof and corruption
  edges. Reusing a coarse parent state declaration cannot grant child parallelism.
- Fixture owners (#2055/#2056) must supply each child's exact current profile,
  producer-plan and independent verification refs through canonical admission.
- Reset owner (#1995) must implement and independently verify
  `reset-pre-notification-stream`; the current verifier has no such assertion.
  Exit zero or a caller-supplied success flag cannot replace the postcondition.
- Quiescence owners (#1683/#1690) must verify each window's runtime generation and
  lease before spawn, retain the fence during measurement, and verify release.
- Runtime host owner must provide independently admitted single-scenario execution
  on one shared host/lease, plus health/state postflight after failure. The current
  `includeScenario` API still initializes a host per invocation; it does not prove
  shared-host exact-once lifecycle. The existing legacy shell fallback also omits
  the live notification scenario, so resident/legacy parity is still unaccepted.
- Shared shell owner (active PR3733) must replace the three original sequential
  functions through the canonical compiler once capabilities are available. No
  shell fallback is added here. Matrix/registry/inventory owners must register the
  actual new tests and producer membership; this module does not edit their files.

## Verification boundary

The three `tests/tools/public-runtime-producer-*.test.mjs` files verify source parity,
current-input consistency and declared edges through the actual weighted scheduler
using synthetic fixtures. These fixtures do not stand in for real runtime,
independent authority verification, native provider acceptance, or local/CI/resume
compiler parity. The old sequential lanes remain active until the owned handoff is
implemented. All three issues remain open with runtime acceptance unmet.

## Canonical compiler and attempt adapter

The ordinary merge consumes framework `653ef38e2ce6dbcf8e2671bd8e091eb9c04538a0`
and structural follow-up `ebf0d6e0e555ba8bf64ceb4dbc9de6427cc1699c` through
scheduler-terminal provider `2eda290cc6098971b685b3fb1465d7193bd3dde2`. Their
compiler, executor, scheduler, attempt runner and finalizer/receipt sources remain
unchanged. This module does not create a scheduler, runner, matrix or host.

`publicRuntimeAtomicNodes({ declarations, attachment, authorities }, options)`
translates the existing domain nodes into the canonical closed atomic schema.
`attachment` supplies explicit logical parent/projection ownership and exactly one
producer binding per executable child. State predecessor edges come from the
referenced state owner's explicit `requiredPredecessors`; missing or unknown
access is refused. Release argv remains exact. Load argv invokes the original
`performance-admission.mjs` and keeps its window IDs, noise paths and client npm
commands. Host/reset command sources must bind their exact source execution
contract; the adapter does not infer single-scenario execution from a phase CLI.

`compilePublicRuntimeProducerDag(inputs, options)` compares these mapped nodes
with the caller's existing matrix attachment and invokes the actual
`compileAtomicProducerDag(matrix, authorities)`. It never writes or constructs a
replacement matrix. The result retains `runtimeAuthorityStatus: unverified` and
the unresolved domain requirements alongside the actual compiled plan.

`preparePublicRuntimeAttemptContexts(binding, inputs, execution, options)` verifies
current run/source/worktree, exact client cwd, backend/preview URLs, original HTTP
timeout profiles, special governance environment and the original replay plan's
environment/source/run binding. It returns the same owner-supplied producer
contexts for `executeCompiledAtomicProducerDag`, which directly calls the original
`runProducerAttempts`. The prep result is not execution admission: installed
fixture, postcondition, quiescence and host/lease verification remains required.

`publicRuntimeSettledResetContract()` reports the actual canonical verifier's
support for `pre-notification-stream-ready`; it is currently unsupported. Reset
maps to executable `hard-prerequisite`, with a settled incoming first-window edge,
an ordinary second-window edge, and its own first attempt. It must not become a
settled join or an always-run finalizer.

`adaptPublicRuntimeSettledReset(...)` is the executor owner's postflight adapter.
It preserves non-success terminals. For success it independently validates the
original aggregate/attempt and artifact refs through `validateAggregateAttemptReceipt`
and `verifyFileDigest`, requires actual postcondition support, exact run/source and
`producerStep.atomicCommand` argv, then calls the existing
`consumeResetPostconditionReceipt`. The canonical reset owner must also supply its
original string `producerStep.command`/`reset.producerCommand` contract; argv is
never joined into an invented shell command. Missing postcondition capability
continues to refuse even an actual clean first attempt.

The framework executor currently has no per-executable postflight transformation
hook. Exact request to its owner: call this adapter after the original reset
attempt is validated and before terminal success can unlock the second window;
retain its failure in the complete vector. This hook, real reset command/verifier,
shared-host single-scenario API and native result bridge must be supplied before
production shell adoption. The production-correctness terminal finalizer in the
supplied scheduler provider is aggregate-scoped; this module does not rename its
target tier or mint aggregate qualification for a domain child.

New ordinary integration controls compile all three domain shapes and execute
only temporary synthetic release source fixtures through the real canonical
runner. Those fixtures use the provider's existing isolated command fixture,
produce actual attempt files and remain explicitly non-qualified. AOT assertion
failure retains SEO's healthy attempt; actual exit-zero reset fixture attempt still
fails postcondition admission. These are not native product, browser, runtime,
semantic audit or production-cohort evidence. No denied audit cases or content
API mutations are executed.
