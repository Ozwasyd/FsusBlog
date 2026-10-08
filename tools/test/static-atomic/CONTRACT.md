# Static atomic source contracts

This domain source increment serves #2251 and #2272. It is not attached to the
shared matrix, compiler, inventory or local/CI entry points. Those owners must
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

All projections explicitly retain `qualificationEligible: false` while membership
and shared integration are incomplete. Missing/blocked child receipts are refused
rather than treated as successful executions. The existing scheduler's in-memory
blocked terminal record is not yet an externally verified attempt reference; this
module does not manufacture one.

## Required shared integration

The #2248 owner must provide the generic declaration compiler over the existing
weighted scheduler and runner, including exact-one attempt execution, hard
prerequisite edges, verified blocked terminals, settled joins and finalizers.
That compiler is absent at this increment's base. The existing command-manifest
runner lacks per-child attempt wrapping and is not a substitute. Its isolated
scheduler controls in this increment are tests of the domain adapter/projection,
not evidence of a completed compiler or current runtime qualification.

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
including a separately verified blocked-terminal extension from #2248. There
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
the source-only siblings. Blocked dependency propagation remains unaccepted until
the compiler supplies real authority-bound edges and terminals.

## Evidence and remaining acceptance

Focused controls use explicitly synthetic commands and authority verifiers to
exercise actual first-attempt directories, logs and receipts, distribution/network
failure isolation, simultaneous failures, warning failure, complete settled joins,
input/environment/network refusal, duplicate launch and receipt/log tamper.
They exercise the existing weighted scheduler directly in isolated fixtures.
They are not real production receipts or independent acceptance.

The old entry points still execute their original paths. Matrix/CI digest parity,
blocked terminal projection, canonical matrices reuse, owner stable-ID confirmation
and current full-lane execution remain open issue acceptance conditions. Neither
issue is closed by this source increment. Revert the domain source increment if
its command/identity contract is incorrect; no production rollout has occurred.
