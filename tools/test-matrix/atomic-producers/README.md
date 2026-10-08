# Atomic producer source contract

This module is a source implementation for the atomic producer contract and
compiler. `tests/matrix.yml` remains the topology authority. There is no active
atomic attachment or second catalog in this directory. The test fixture supplies
synthetic upstream projections and cannot qualify a release.

## Contract and upstream boundary

`validateAtomicProducerDeclarations(matrix, authorities)` consumes only
`matrix.atomicProducerDeclarations`. Its closed v1 schema distinguishes physical
producers, hard prerequisites, settled joins, logical projections and finalizers.
Executable children have exact-one physical ownership, command-free parent
projection, first-attempt correctness policy, source/input-closure binding,
fixture/resource/replay references and explicit runtime state references.
Parents consume the existing `executionMode=projection`, `commandKind=projection`,
`executionOwner` and `projectFrom` matrix fields. Projection identity is explicit;
it is not inferred from a parent name or suffix.

The required `authorities` argument is an integration boundary for upstream
owners, not a new physical catalog or input analyzer. It contains the exact
`matrixDigest` plus these owner-supplied projections:

| Projection | Required material |
| --- | --- |
| `physicalOwnership` | `producerId`, `logicalParentId`, `owner`, `commandSourceRef` |
| `commandSources` | sealed `id`, one argv `command`, `executableAuthorityCount=1`, `inputClosureRef` |
| `inputClosures` | sealed `id`, `commandSourceId`, `commandDigest`, empty `unresolvedDynamicReads` |
| `fixtureProfiles` | sealed fixture identity referenced by the replay owner |
| `replayPlans` | `id`, `replayOwner`, `fixtureProfileDigest`, `artifactPath`, exact file `bytes`; owner retains test/worker/shard/seed selection |
| `resourceContracts` | sealed `id` and existing weighted-step `resources` |
| `stateAccess` | sealed `id`, `producerId`, `unknownAccess=false`; canonical state owner retains access analysis |
| `finalizerOperations` | sealed `id` and one existing scheduler finalizer `purpose`, without command/tests/build |

References are `{ id, contentDigest }`. Replay references additionally carry
`planDigest`. Their `contentDigest` binds the exact artifact file bytes; their
`planDigest` binds the original unsigned #1600 plan through the original
`validateReplayPlan` validator. These digests are distinct and never interchanged.
Other material digests use the existing attempt
provenance canonical JSON digest excluding `contentDigest`. Validating references
does not independently admit their source, prove complete input closure or
certify state access. The upstream owners must supply the actual validated
projections and an integration adapter to this boundary.

## Disposition audit

`validateCompositeLeafDisposition(inventory, authorities)` requires exact source
observation/disposition equality, proof identity and one migration child from the
tracking owner's supplied `migrationOwners` roster. Each observation has
`location`, `parentId`, `childCommandIdentity`, `commandSourceRef`,
`authorityKind` and `proofTestIds`. The closed authority kinds distinguish a
producer from cleanup, inventory, projection, diagnostic and embedded work.
No command ordering is used to infer dependencies or independence.

`compositeObservationDigest` and `renderCompositeLeafDisposition` sort the audit
roster deterministically. Generated text remains an audit projection and cannot
be fed back as topology. The source owner must enumerate shell functions, Node
groups, workflows, package scripts and matrix children; fixture completeness is
not current repository completeness.

## Compiler and execution

`compileAtomicProducerDag(matrix, authorities)` returns a deeply frozen, sealed
projection. `verifyCompiledAtomicProducerDag` recomputes the exact projection to
reject tampered or independently resealed plans. All consumer modes can use this
same function; no mode-specific edge or command roster is maintained here.

`executeCompiledAtomicProducerDag` calls the existing `executeWeightedStepDag`
and `runProducerAttempts` directly. Each executable receives the existing
`correctness-first-attempt` policy. The external authority verifier must bind the
current producer/run/source/worktree, and its replay digest must equal the
compiled replay reference. It cannot replace the compiled command or retry
policy through execution options. Source, run, command and environment must match
the canonical replay plan, and expected tests come directly from its sealed
`testEnumerationOrder`. Finalizers receive only their operation
reference and dependency terminal observations through a digest-bound installed
owner capability. Their implementation remains the cleanup/inventory owner's
responsibility.

Executed producers retain their original attempt and aggregate receipts. Settled
joins and finalizers write exclusive evidence files. The final sealed vector
records every scheduler terminal state, blocked predecessors, attempt/artifact/
evidence references and content digests. Failure throws
`AtomicProducerExecutionError` with `terminalVector`; it never becomes success.
The vector explicitly has `qualificationEligible=false` because this source
increment does not admit consumer or runtime integration.

An attempt-runner exception becomes an `internal-error` adapter observation,
releases the scheduler grant and leaves independent producers/finalizers eligible.
The observation explicitly says it has no verified attempt; it cannot substitute
for a missing runtime receipt. Existing attempt files are retained.

The current shared attempt runner refuses an exit-zero command without a result
sidecar as `invalid-success-result-sidecar`. This remains a real integration
blocker for unchanged lane commands. The adapter does not fabricate sidecars or
relabel the failed attempt. A canonical runner-owner fix or approved existing
producer result bridge is required before those commands can be admitted.

## Verification and remaining integration

Run the isolated controls with:

```bash
npm ci --ignore-scripts --prefix tools/test-matrix/schema-validator
node --test tests/tools/atomic-producer-contract.test.mjs tests/tools/atomic-producer-compiler.test.mjs
```

Current master still has the Production exactly-five guard and no usable general
transitive-input-closure API. Physical ownership, matrix-schema attachment and
current complete composite-child observations are required from their canonical
owners. No existing lane, workflow, command, membership or execution edge is
changed here. Domain migrations and consumer registration remain separate.

The bounded scheduler correction preserves the original global interruption,
settles active producers through their owner signals, cancels pending physical
admission, then runs declared settled joins and leaf finalizers. The bridge combines
global and producer signals for the original attempt runner. Every declared node
retains a terminal receipt, and cleanup failures remain secondary to physical
failures or cancellation. Capacity-safety and resource-provider internal errors
still require their canonical owner's terminalization capability. Required-artifact
declaration enforcement remains with the canonical producer/attempt authority;
this adapter consumes its receipt without promoting it after an external failure.

Current full inventory, generated current-doc admission, local/Fresh/resume/CI
consumer adoption, canonical runtime state integration, broader cancellation
acceptance and independent review remain open. Exact local fixture execution
does not substitute for those conditions.

Cross-directory dependencies use the existing explicit module URL representation:
`await import(new URL(<literal relative source>, import.meta.url))`, with the
`URL` constructor imported from `node:url`. Each source path and named binding
remains enumerable by the original canonical Node AST dependency inspector.
No path alias, forwarding facade, substitute implementation, or lint exception is
introduced. The structural follow-up retains the stable cancellation commit
`653ef38e2ce6dbcf8e2671bd8e091eb9c04538a0`; source dependency closure and bindings
are checked against that commit. Strict source checks still require canonical
baseline admission and independent review; zero file diagnostics does not waive
stale shared baseline bindings or provide native qualification.

If terminal-vector publication fails after execution has already failed,
`AtomicProducerExecutionError.cause` retains the original scheduler failure and
`publicationError` retains the write error as a secondary diagnostic. Its in-memory
`terminalVector` is available, but the error does not claim successful publication.
When execution had no earlier failure, the original write error is thrown directly.

An executable's `producerContexts[id].requiredInputAdmission` may install an
additional domain-owned input reader as `{ inputClosureRef, validate }`.
`inputClosureRef` must match that exact compiled producer's sealed input closure;
when configured, the closed operation and validator are mandatory. The async
validator runs once after dependency readiness and resource admission, before
calling the unchanged attempt runner or allocating any attempt directory. It
receives frozen producer, command, dependency, grant and run context plus the live
signal. It must only read/check required material and throw on unavailable input.
Its return value has no execution or authority effect. Existing command and
wrapper checks remain mandatory; an absent hook supplies no admission evidence.

A validator exception retains the original Error as the DAG's primary cause and
records `failed` / `required-input-admission-failed`, with no attempt reference.
Its existing terminal evidence reference points to the framework's own observation
`required-input-admission-refused-before-attempt`, bound to the compiled DAG and
input closure, with observed attempt allocation and physical spawn counts of zero.
Hard descendants retain the existing blocked behavior; siblings and leaf finalizers
continue under the original scheduler. This is distinct from a failed predecessor's
blocked receipt: no predecessor failure or canonical qualification is invented.
Coverage consumers must recognize this explicit zero-attempt refusal; their older
null-attempt branch reports unknown counts. All domain input validation and native
acceptance remains with its original owners.

The original runner distinguishes process-only invocation from declared test
membership through `expectedTestIds`. An empty roster permits a normal exit-zero
command with no result sidecar and records empty executed/failed test IDs; it does
not create `result.json` or native test telemetry. A nonempty roster still requires
a real `fsusblog.test-attempt-result.v1` sidecar at
`FSUSBLOG_ATTEMPT_RESULT_PATH`. Missing required results retain
`invalid-success-result-sidecar`; supplied sidecars retain the existing parser and
failure-field checks. Absent results never convert planned IDs into executed IDs.
With an absent sidecar, existing nonzero, signal, timeout and cancellation
classification takes precedence over the missing-result check.

The static canonical bridge at
`ab9a2493c54e1357e4d2b3c74796cb657cd7c34f` binds nonempty replay membership to all
its physical producers and requires exact observed IDs in terminal projection.
Those invocations therefore still need their original producer/observer to emit
a real result sidecar with actual executed IDs (and failed IDs/artifacts, when
applicable). Emptying replay membership or manufacturing sidecars from the plan
is not an implementation of that requirement. This repair only supplies ordinary
process-only behavior and truthful absent-result observations; it cannot qualify
or complete the thirteen native/static consumer executions.
