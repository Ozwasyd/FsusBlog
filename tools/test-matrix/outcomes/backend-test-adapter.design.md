# Backend semantic outcome adapter

This implementation note describes `backend-test-adapter.mjs`, owned by #2650.
The existing #2020 candidate, taxonomy and strong DATA_ONLY contracts remain the
sole outcome authorities. The adapter returns
`fsusblog.producer-semantic-outcome-candidate.v1`, never the strong fingerprinted
producer outcome. `verifyBackendTestSemanticOutcomeCandidate` reopens the same
held inputs through the supplied capabilities and compares the complete candidate.

## Required inputs and custody

`adaptBackendTestSemanticOutcome` requires the canonical sealed replay `plan`,
`identity`, an execution-owner sealed `catalog` and `report`, the original
`attempt` and `aggregateAttempt`, and exact `inputAuthorityRefs`. The input kinds
are `replay-plan`, `backend-catalog`, `backend-report`, `attempt`, and
`aggregate-attempt`; applicable projections add `evidence-projection`. References
contain `kind`, a contained relative `path`, and `digest`. The attempt path must
match the original aggregate reference. These paths are evidence locations and
are outside the semantic membership payload.

The original `validateReplayPlan` and `validateAggregateAttemptReceipt` validate
seals, source/run/producer identity, external replay/envelope/temporal authorities,
policy and attempt eligibility. Planned IDs come exclusively from
`plan.testEnumerationOrder`; the catalog and report must cover that exact set.
No retry policy, assertion, skip behavior or runner is changed. Only a first and
sole correctness attempt is consumable. A failed first attempt can produce a
failed candidate with `firstFailure` retained and `qualificationEligible=false`;
it cannot produce a qualified success. Diagnostic and recovered attempts refuse.

Three external capabilities are mandatory:

- `verifyAuthority(reference)` is the existing attempt owner's interface. It must
  verify the held replay/envelope/temporal artifact and verification-receipt digests
  and actual source/run/producer identity.
- `verifyArtifact(path, digest, attempt)` must verify actual retained bytes from
  the current attempt. Every report evidence reference must match that attempt's
  artifact table; paths outside its retained roster refuse.
- `verifyBackendEvidence({ identity, inputAuthorityRefs })` belongs to the
  execution/evidence owner. It must independently reopen every listed input and
  join catalog case/assertion identities, raw framework events, semantic snapshot
  and state digests, randomized input/shrink/transition observations, and applicable
  projection receipts. It returns exactly `verified`, `identity`,
  `inputAuthorityRefs`, and `verificationReceipt: { path, digest }`. The receipt's
  actual path/digest becomes an input authority reference. This callback must
  compare independently held expectations; echoing the request, report booleans,
  a successful exit or a content seal alone supplies no authority.

Input JSON data is copied before validation; proxies, accessors, nonplain objects,
hidden fields, cycles and sparse arrays refuse. The local observation boundary
has finite 64-level/100000-node limits. These are adapter input limits and do not
substitute for #2020's independent explicit strong-schema `hostExpectedLimits`.

## Backend observation binding

The catalog schema is `fsusblog.backend-outcome-case-binding.v1`, an observed
execution-owner binding rather than a new test inventory. It contains `identity`,
`policyDigests`, `tests`, and `contentDigest`. Policy digests bind the actual
original retry policy, canonical taxonomy entries, and an explicit nullable
`projectionPolicyDigest`. Each test has `testId`, `caseBinding: { kind, id }`, and
explicit `assertionIds`, `coverageIds`, `artifactIds`, `stateIds` arrays. Framework
display names cannot replace the canonical replay identity. xUnit theory
bindings use the exact sealed `parameterized` unique ID. Model consumers retain
the existing replay grammar: a case suffix, when present, uses `property` while
the catalog identifies the model semantics separately.

The report schema is `fsusblog.backend-outcome-framework-observation.v1`. It
contains the exact same `identity`, `attemptDigest`, `catalogDigest`,
`frameworkStatus`, `tests`, `evidenceRefs`, `artifactSemanticDigests`,
`stateSemanticDigests`, `terminalFailure`, and `contentDigest`. `evidenceRefs` are
unique `{ id, path, digest }` references to attempt-retained raw evidence.

Each test observation contains `testId`, `caseBinding`, one terminal `status`,
explicit `cases`, `assertions`, `coverageIds`, `artifactIds`, `stateIds`, and
`evidenceId`. A case contains `caseId`, nullable `inputDigest`, nullable
`shrinkSequenceIdentity`, and explicit `transitionIds`. Randomized input digests
are required. The independently verified raw observation supplies exact generated
case and shrink identities; the adapter does not infer them from logs. Each
assertion contains `id`, `caseId`, `status`, `evidenceId`, and an explicit nullable
`failure`. Passed cases require exact planned assertion membership. Failed tests
require a canonical failing assertion and every observed case has assertion
proof. Duplicate, extra or cross-case assertions refuse. Skipped/blocked tests
have empty case/assertion arrays and retain distinct terminal memberships.

Failures contain explicit `class`, taxonomy `kind`, `identity`,
`diagnosticEvidenceId`, `semanticArtifactIds`, and `stateIds`. Assertion failure
identity binds producer/test/case/assertion plus the taxonomy's required fields.
The class must match the structured kind, never message text. Semantic IDs must
reference applicable state/artifact IDs. The report's first failure topology must
agree with the attempt's canonical failure class/kind. A process crash additionally
retains an infrastructure `terminalFailure` with producer/attempt identity and raw
diagnostic proof; it does not invent a test or assertion for a process-level event.
If a started test has no usable assertion/failure proof, that partial input refuses
until its original execution owner supplies the missing proof.

## Output and relations

Membership contains planned/executed/passed/failed/skipped/blocked test sets,
assertion and generated case identities, coverage IDs, applicable semantic
artifact/state maps, policy digests and projection-receipt references. As required
by #2020, `executed = passed union failed` and
`planned = executed union skipped union blocked`, with disjoint terminal sets.
Single terminal records and an exact unique planned/report join enforce those
relations. Attempt executed/failed membership must match in both directions.
A crash preserves prior pass/failure records and explicit blocked records; an
unproven omission is never converted to `not-run` or guessed blocked membership.

Inapplicable coverage is `[]`, snapshot/state maps are `{}`, and projection
references are `[]`. Applicable references must exactly match the catalog. A
projection additionally binds the existing success-only sealed projection schema,
source/run/producer/build/policy/test/coverage identities. Failed source evidence
cannot be certified by a success-only projection. Raw diagnostic digests, paths,
duration, process identity and messages stay outside semantic membership.
The original candidate primitive computes its membership content digest and seal;
this adapter computes neither an outcome fingerprint nor an aggregate.

## Integration gaps and rollback

The bounded native bridge below consumes actual xUnit v2 reporter material.
The original randomized TRX parser admits passing results only: failed property,
model and fuzz assertion/input/shrink/transition observations still require their
execution owner's emitter. #1601 actual all-producer temporal observations and
#1602 envelope tracking retain their original unfinished acceptance. Source
adapter controls use explicitly identified in-memory verifier doubles. Native
bridge controls execute the original reporter and real assertions, while preserving
missing replay/envelope/temporal authorities and unqualified probe identities.

#2020's canonical registry currently profiles build/projection/finalizer only.
Its owner must register this backend authority and the membership fields above
for the actual backend producer IDs before #2025 analysis can consume them.
Global matrix/lifecycle registration must be assigned to their canonical owners;
this partition does not edit shared authority files or generated inventories.

Rollback this adapter increment if it rejects a legitimate held case or loses
failure topology, keeping original source receipts and all refusal controls.
Correct the owning contract through its owner before changing accepted semantics;
never relax custody or qualify fixtures to unblock a runtime lane.


## Bounded native xUnit bridge

`backend-held-evidence-bridge.mjs` exports
`buildBackendFrameworkObservationFromXunit({identity,plan,catalog,attempt,
queueManifest,slotExecutions,assertionObservations,evidenceRefs,
artifactSemanticDigests,stateSemanticDigests})`. It joins the existing canonical
queue manifest to actual `fsusblog.xunit-replay-slot-receipt.v1` admissions,
starts and outcomes. Slot PID, plan, collection, native test unique ID, native
case unique ID and exact planned membership must agree. The bridge does not infer
assertion IDs or failure classes from framework outcome messages.

The separately retained `fsusblog.backend-native-assertion-observation.v1` has
`schema`, exact `identity`, `testCaseUniqueId`, `cases`, `assertions`, `coverageIds`,
`artifactIds` and `stateIds`. Native fact/theory cases use the original case unique
ID, nullable input/shrink fields and empty transitions. Assertions contain `id`,
`caseId`, `status` and explicit nullable `failure`; canonical product assertion
failures bind producer/test/case/assertion and applicable diagnostic/semantic
references. The xUnit bridge currently admits `product.assertion`; broader
structured process/randomized failures remain with their actual emitters.

`createBackendHeldEvidenceBridge({evidenceRoot,expectedIdentity,
inputAuthorityRefs,queueManifestReference,slotExecutionReferences,
assertionObservationReferences,artifactSemanticReferences,stateSemanticReferences,
verificationReceiptPath,maximumBytes})` returns `verifyArtifact` and
`verifyBackendEvidence` for the existing adapter. References bind contained paths
and raw-byte digests; slot references additionally pin `slotId`, `processId`,
`exitCode` and `signal`. Semantic references add `semanticDigest`. Independent
expected identity/references are copied when the owner creates the bridge.
Each verification reopens all inputs and raw observations, reconstructs the report,
and compares it completely. Semantic artifact/state bytes are reopened and checked
against their independent canonical digests. The explicit per-file bound must be
positive and no greater than 16 MiB. The original private-file reader enforces
private mode, single-link regular files, no symlink, size bound and stable open
file identity; this bridge additionally rejects containment and parent-path aliases.
The original private JSON writer retains the verification receipt.

The receipt scope is `native-observation-binding`, with
`qualificationGranted=false`. A verified raw observation is insufficient to admit
a qualified candidate: original attempt replay/envelope/temporal authorities and
`verifyAuthority` remain mandatory. The original runner emits a final slot receipt
only after completion. Its missing process-crash capability is an incremental
`RunSlotAsync` event journal in `tools/test/xunit-replay-runner/Program.cs`, carrying
sealed plan/slot/PID, admission/start/outcome records and the actual terminal
process result so retained partial topology can be verified. The bridge refuses
signals, unknown exits and missing outcomes until that owner supplies this API.

The test-only locked xUnit v2 fixture emits observations around actual
`Assert.Equal` calls. Its native test-case context comes from the existing xUnit
case execution API; no display-name identity inference or original runner edits
are used. Build with `dotnet restore --locked-mode` and `dotnet build --no-restore
--configuration Release` for the fixture project, then run
`FSUSBLOG_BACKEND_DOTNET=<actual dotnet executable> node --test
tests/tools/backend-held-evidence-bridge.test.mjs`. The suite runs the original
`tools/test/xunit-replay-adapter.mjs` against two passing theory rows and one real
failing fact. Original reporter exit 1 is expected evidence of that assertion;
the control suite must independently exit 0. An absent SDK/build is an unmet
prerequisite and is never silently skipped. The fixture's envelope/context hashes
are explicitly unqualified diagnostic descriptions, not authority receipts.
