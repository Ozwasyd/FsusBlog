# Static atomic source contracts

This domain source increment serves #2251 and #2272. It consumes the canonical
compiler/executor as an owner-supplied library contract; it is not attached to the
shared matrix, inventory or local/CI entry points. Those owners must
complete the integration described below before these issues can be accepted.
No product checker, runtime phase, security policy or output schema changes here.

## Available APIs

`staticAtomicDeclarations(repositoryRoot)` returns thirteen independent command
declarations and two command-free settled projections. Its digest includes the
current package-script bodies and the existing cross-stack assertion registry.
Existing assertion, test, coverage and artifact IDs are read from that registry;
no new IDs are assigned to the five security checks without registered assertions.
The original logical physical test IDs are retained as metadata. Producer IDs
still need confirmation by the canonical ownership and coverage owners.

`runStaticAtomicProducer({ repositoryRoot, producerId, inputClosureDigest,
context })` launches exactly one declared command through the existing
`runProducerAttempts` API, using `correctness-first-attempt`. Caller command and
retry overrides are not forwarded. Repeating a producer in the same run fails at
the existing exclusive attempt directory. The adapter does not schedule children,
repair failures, retry or discover tests. No CLI fan-out runner is introduced.

The context supplies the existing runner's source/run identity, evidence root,
explicit string-valued environment, timeout, cancellation signal and three
external authority references. Its `verifyAuthority` must be the real external
owner verifier, not a caller assertion. The execution-envelope verification must
add `staticAtomic`, binding these fields exactly:

- `declarationDigest`, `commandDigest`, `inputClosureDigest` and `cwd`;
- `environmentDigest`, `resourceContractDigest` and `prerequisiteSetDigest`;
- `network`, `networkEnforced: true` and, for policy-bound network access,
  a nonempty SHA-256 `networkPolicyDigest`.

The external envelope owner must hold and verify the complete source/transitive
input closure, declared prerequisites, toolchain resolution, read/write boundaries
and actual network enforcement. A digest alone is not proof of that enforcement.
Network/toolchain ambient variables, custom output locations and private package
authentication remain part of the exact verified environment. Supply-chain audit
retains its original npm/NuGet commands and restore/network boundaries. SBOM reads
local dependency locks and image metadata, requiring no restore or network access.
The network baseline retains its original exposure tool tests and cannot request
the existing skip option through this adapter. Its temporary fixture writes remain
owned by its unchanged checker.

`projectStaticAtomicSummary({ repositoryRoot, evidenceRoot, lane, identity,
children, verifyAuthority })` accepts the exact complete executed child set. Each
child contains `producerId`, `attemptPath`, `attemptDigest` and the adapter's
`binding`. Paths are confined regular files; attempt bytes, authority references,
source/run/command/test identities, first-attempt policy and all log/artifact
digests are verified before projection. Every failure or cancellation is retained
in the status vector with its attempt, replay, input and evidence references.
The projector runs no checker and cannot infer success from source/artifact
existence. `verifyStaticAtomicSummary(receipt, options)` rereads all children and
rejects changed or resealed summary outcomes. Trusted child refs must come from the
compiler's exact run checkpoint; these APIs do not grant terminal authenticity to
an arbitrary caller-provided reference set.

All projections explicitly retain `qualificationEligible: false` while canonical
identity admission and shared integration are incomplete. The original executed-only
projector still refuses absent attempts. The canonical terminal bridge below accepts
verified zero-spawn blocked records without manufacturing attempts.

## Required shared integration

The canonical framework is now available: original execution capability
`653ef38e2ce6dbcf8e2671bd8e091eb9c04538a0`, structural successor
`ebf0d6e0e555ba8bf64ceb4dbc9de6427cc1699c`, and canonical scheduler terminal
capability `2eda290cc6098971b685b3fb1465d7193bd3dde2`. This branch consumes their
actual ancestry and preserves the upstream compiler, executor and scheduler bytes.
Open upstream issue status does not imply these usable source APIs are absent.

`validateStaticAssertionMembership(producer, membership, replayPlan)` preserves
all original registry bindings and legacy IDs while validating an owner-supplied,
sealed canonical replay enumeration. It does not invent live test registrations.
Every original assertion needs an explicit canonical observation; the five checks
without registered assertions need explicit nonempty additional membership.
Missing, altered, overlapping or extra observations fail closed.

`bindStaticAtomicCompilation({ repositoryRoot, matrix, authorities, memberships,
prerequisiteBindings })` consumes the owner-supplied attachment through the sole
`compileAtomicProducerDag`. It verifies unchanged commands/resources, the canonical
matrices physical owner, all thirteen membership bindings, real hard prerequisites,
or prerequisites explicitly held by the exact compiled input closure. It does not
add a frontend install/backend build edge to source-only checks or build a matrix.
`verifyStaticAtomicCompilation` recomputes the exact compilation and binding.

`executeStaticAtomicCompilation(compilation, options)` calls the canonical executor
once after verifying the domain envelope bindings and explicit environment. It
preserves `AtomicProducerExecutionError` and its complete terminal vector; callers
must consume that vector without flattening failure into success. No child runner,
scheduler, replay compiler or finalizer implementation is duplicated.

`projectCompiledStaticAtomicSummary({ compilation, compilationOptions, vector,
expectedVector, context, producerContexts, lane })` verifies the pinned complete
canonical vector, exact current source/run identity, all executed first attempts,
aggregate/log/artifact digests and canonical settled projection evidence. Blocked
children require actual unsuccessful declared hard predecessors, no attempt and
no execution artifacts. Cancellation/internal errors without verified attempts
remain non-success. Original assertions and canonical membership remain attached.

`readCurrentStaticAtomicSummary({ checkpointFile, expectedCheckpointDigest,
evidenceContext, expectedVectorDigest, consumerId, authorityId, ...projectionOptions })`
uses the existing immutable canonical journal reader without repair or compatibility
JSON fallback. It requires an exact current-attempt reference block, owner-supplied
consumer/authority IDs, finalized native publication state and the native sealed
reference wrapper, then verifies its payload bytes and vector. The checkpoint
reference `inputDigest` hashes wrapper bytes; `contentDigest` and
`producerReceiptDigest` seal the wrapper, not the atomic vector. The vector's own
digest is pinned separately. Readback refuses a changed checkpoint. This read-only
bridge grants no correctness lease, terminal seal or release qualification.

The existing attempt runner also rejects a real exit-zero command without its
optional result sidecar: `failureIdentity` compares optional-chain `undefined`
against `null` and records `invalid-success-result-sidecar`. Original static
checkers do not emit that sidecar. This increment leaves the shared runner
unchanged and preserves its refusal, with a focused negative control. Its owner
must supply the exact reviewed no-sidecar process-outcome fix (while still
rejecting malformed/contradictory sidecars), or an authorized original result
bridge, before these unchanged commands can produce a clean current attempt.
The synthetic positive controls explicitly emit sidecars; the domain adapter
does not create them or relabel real zero-exit failures.

The #1686 and physical ownership owners must confirm IDs, register tests and
attach declarations once, preserving the matrix/DAG identity across direct,
Production Fresh, resume and CI. `security-matrices` already belongs to
`frontend-static-governance/security-matrices`; its existing deterministic physical
wrapper must execute once and project to both consumers. Do not schedule a second
copy or nest another attempt over an already attempted canonical child.

The shared lane owner must then replace `RunCrossStackStaticContracts`' six-command
sequence and `RunSecurityStaticOnly`'s seven-command `RunParallel` with consumption
of the compiled domain DAG. The cross-stack receipt owner must replace static
artifact-existence receipt production with these verified child projections,
including the available canonical terminal bridge. There
must remain one static summary per domain. Runtime phase commands and identities
must stay separate. The combined frontend `check:cross-stack-contract` script also
needs owner-controlled static routing; retaining its static commands would cause
duplicate executions after cutover. None of those shared files is edited here.

The six coherence checks use Node built-ins and source fixtures only. Invoking
them through npm does not require `node_modules`, frontend install, backend build
or runtime bootstrap. Do not copy the old parent bundle's build/security ordering
into child hard prerequisites. PoW's optional observed/generated OpenAPI input
selection must be held by its input authority; a mutable preferred file is not an
implicit build edge. Supply-chain's restore/network admission is independent of
the source-only siblings. Owned controls now exercise real canonical blocked propagation. Production
prerequisite authorities and real current-run publication remain unaccepted.

## Evidence and remaining acceptance

Focused controls use explicitly synthetic commands and authority verifiers to
exercise actual first-attempt directories, logs and receipts, distribution/network
failure isolation, simultaneous failures, warning failure, complete settled joins,
input/environment/network refusal, duplicate launch and receipt/log tamper.
They exercise the existing weighted scheduler directly in isolated fixtures.
They are not real production receipts or independent acceptance.

The old entry points still execute their original paths. Matrix/CI digest parity,
current-run terminal publication, canonical matrices reuse, owner stable-ID confirmation
and current full-lane execution remain open issue acceptance conditions. Neither
issue is closed by this source increment. Revert the domain source increment if
its command/identity contract is incorrect; no production rollout has occurred.

## Exact shared-owner requests

The runner owner must supply a reviewed presence guard in `failureIdentity`:
inspect structured failure fields only when `structuredResult !== null`. A missing
optional sidecar can then use the unchanged process outcome and canonical replay
`expectedTestIds`. Explicit sidecars still require the existing closed schema and
all failed/executed test/artifact checks; malformed or contradictory sidecars must
continue to fail. Exit zero alone does not qualify evidence: the external execution,
input/network and replay authorities, first-attempt policy, sealed logs and complete
assertion membership remain required. This partition does not edit that runner.

The canonical compiler currently requires a logical projection to settle exactly
its executable children with the same `logicalParentId`. It cannot also project a
`security-matrices` physical child whose parent remains frontend-static-governance.
The matrix/physical ownership and compiler owners must provide an exact shared-child
projection contract or explicitly assign compatible parent ownership. This bridge
refuses a second physical copy and does not change shared ownership to make a fixture
pass. Its synthetic attachments explicitly assign the matrices physical owner to
frontend-static-governance; they are not a live ownership admission.

The publication/registry owners must admit the exact static observer/vector
reference contract (including failed/blocked vectors as data) and attach it to the
canonical current-attempt journal. Success-only correctness finalizers cannot
admit those vectors as successful correctness. Positive native publication controls
prove read compatibility only; no live entry, permission or receipt is fabricated.
