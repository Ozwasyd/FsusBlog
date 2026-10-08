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

The canonical catalog supplied at `3f6f443ac4e253f7a9b80e7c7c910d2de8fce824`
(PR3998) now registers this backend authority for `backend-unit` and
`backend-xunit`, pinning unchanged adapter bytes from `dae524b96`. The existing
`readOutcomeAdapterCatalog` and `validateOutcomeAdapterCandidateData` APIs remain
DATA_ONLY source/schema capabilities, not execution qualification. Its backend
membership schema is `#/$defs/backend`; no shared registry is edited here.
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
`verifyAuthority` remain mandatory. The original final slot receipt still requires completion. The incremental
original reporter journal described below now retains callbacks on interrupted
runs. The current held bridge still refuses signals, unknown exits and missing
outcomes: consuming that journal requires the parent's actually observed process
terminal and applicable assertion/attempt authorities, not a new journal flag.

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


## Original reporter incremental journal

`tools/test/xunit-replay-runner/Program.cs` now emits a sibling
`<slot-output>.events.jsonl` while executing its existing `run-slot` callbacks.
The existing queue, final slot receipt, controller settings, test semantics and
return codes remain the original source paths. Every complete event is flushed
through the file descriptor before the next callback proceeds. File creation uses
create-new semantics and private Unix mode. Journal IO/capacity failure is reported
and stops journaling while the original test result path continues unchanged.

Each event has `schema=fsusblog.xunit-replay-slot-journal-event.v1`, `planDigest`,
`slotId`, `processId`, monotonic zero-based `sequence`, `kind`,
`qualificationEligible=false` and `payload`. The records are diagnostic observations,
never a sealed replay receipt or runtime authority. `run-opened` includes native
queue counts and explicit caps: 100000 events, 128 KiB per encoded event including
its newline and 16 MiB per journal. Serialization is bounded before appending;
the final 4096 bytes are reserved for an explicit `journal-stopped` marker where
output remains writable. Interrupted writes can leave an incomplete last line,
which cannot be treated as an observed callback. No record is silently truncated.

`collection-admitted` carries the original `CollectionAdmission`; `test-started`
and `test-outcome` carry the original `TestStart` and `TestOutcome`. A failing
outcome keeps its native outcome and diagnostic detail without message-based
classification. The original complete receipt retains full detail even when the
journal stops on an oversized event. `assembly-finished` records observed counts.
`runner-terminal` records the original return code 0/1, or the original catch code
2 and exception type. Null properties remain omitted, matching the original
serializer. A killed process cannot truthfully emit its own terminal event.
The parent must retain its actual `close(code,signal)`, PID and command context;
a journal without terminal is incomplete, not guessed success or `not-run`.

## Existing parent process and partial publication

The original `tools/test/xunit-replay-adapter.mjs` now exports its existing
`spawnSlot` and `execute` functions. Both accept `inputReferences` and
`executionReferences` arrays, copied at entry and retained without qualification.
The CLI retains its actual sealed plan/manifest path and digest references. Its
optional `--execution-references <file>` reads the execution owner's existing JSON
array through the bounded private-file reader; absent references remain `[]`.
No attempt, envelope or temporal authority is inferred or created.

Each existing native spawn persists `processes/<slot>.json.running.json` with its
actual PID, command, start time, queue reference and supplied references. On actual
`close(code,signal)`, `processes/<slot>.json` adds that code/signal, finish time,
spawn/receipt IO errors and available final receipt path/raw digest. Stdout/stderr
remain mirrored to the original console and are retained in uniquely named private
logs, bounded to 16 MiB each with actual stored/raw digests, total/stored byte counts,
truncation and IO status. `process-results.json` retains those process results and
the original plan's source, producer and run. All new process records explicitly
set `qualificationEligible=false`.

The parent reads only complete native journal lines within the original journal
caps and checks the actual plan, slot, PID and monotonic sequence before retaining
a callback prefix. The journal reference always uses its actual raw-byte digest;
incomplete trailing bytes remain diagnostic and cannot become callbacks. Journal
status is explicit: complete, partial, stopped, unavailable or invalid.

If a process is interrupted or has no usable final receipt, the parent writes
`partial-framework-actual.json` before returning the original CLI failure. It
retains actual process terminal information, queue/plan/source/run identity,
supplied references and observed admissions, starts and outcomes. Case IDs join
only the original queue; unknown cases remain null. It creates no canonical replay
receipt, verification result or guessed terminal test outcome. The complete path
still uses the original final receipt, exact membership checks and replay verifier;
ordinary assertion failure continues to return exit 1.

`tests/tools/xunit-replay-partial-publication.test.mjs` runs that actual CLI for
success, assertion failure and cancellation. The success control preserves an
explicit unqualified reference to actual fixture source bytes; it supplies no
runtime authority. The cancellation control kills only its observed native child
and checks retained pass/fail/skip callbacks plus the live incomplete start.
Controls bound and clean up their own process groups.

Remaining consumer contract: the held semantic bridge still requires independently
held structured assertion observations and original attempt/envelope/temporal
references. This increment provides real process/journal evidence but does not
activate a qualified partial outcome adapter or infer those missing capabilities.

Ordinary callback/output tests live in
`tests/tools/xunit-replay-slot-journal.test.mjs` and use the separate locked
`tests/tools/fixtures/backend-outcome-reporter/journal/FsusBlog.XunitJournalFixture.csproj`.
The original three-case reporter fixture excludes that subdirectory so the wait
and large-output cases cannot enter its default discovery roster. The new controls
run the actual original front controller for pass/fail/skip, SIGKILL after an
observed failure and a flushed live start, journal capacity/unavailable output,
and final receipt IO failure. They record native exits 0/1/2 and signal SIGKILL
without invoking candidate, semantic forgery or reviewer audit suites.
Failed randomized assertion/shrink emission and actual runtime/temporal/envelope
qualification remain separate missing original-owner capabilities.

## Structured native failure callbacks

The existing xUnit `TestFailedEvent` also supplies `ITestFailed.Cause`,
`ExceptionParentIndices`, `ExceptionTypes`, `Messages` and `StackTraces`.
The original reporter now records these actual arrays in a `test-failure`
journal event immediately after its existing failed `test-outcome`, under the
same synchronous callback lock. Native test/case/collection IDs and finish time
are preserved. Existing final receipt fields and assertion/skip/exit behavior do
not change. The original journal caps still apply; a stopped journal cannot claim
missing structured observations. Native `Cause` is retained as a framework enum
name, not mapped to a canonical failure class/kind or assertion ID.

`backend-native-execution-events.mjs::buildBackendNativeExecutionEvents` consumes
the existing parent's actual slot results and original manifest. The parent writes
`backend-execution-events.json` before either the complete or partial result path.
Its `fsusblog.backend-native-execution-events.v1` output is explicitly unqualified,
retaining original plan source/producer/run, manifest digest and owner references.
Each worker contains the observed native journal events, original raw journal
path/digest/sequence references, queue-bound canonical case IDs and actual process
terminal. Its `firstFailure` identifies the first failed outcome in that slot's
original journal sequence and links matching structured failure material when
present. There is no invented cross-slot total failure order.

`incompleteStarts` lists starts with no observed matching terminal callback;
`queuedCasesWithoutCallbacks` lists original queued cases with no retained callback.
These remain observation gaps, not synthesized failed/blocked/not-run outcomes.
The emitter creates no semantic candidate or canonical assertion membership.

At actual spawn, the parent snapshots the existing child environment.
If `FSUSBLOG_RANDOM_EXECUTION_ATTEMPT` exists, `attemptContext` retains that exact
attempt ID and the originally supplied `FSUSBLOG_RANDOM_EXECUTION_RUN` and
`FSUSBLOG_REPLAY_PLAN_DIGEST` values (nullable when absent). Otherwise the context
is null. This diagnostic context is not an attempt receipt or verified identity
join. The original `run-replay-qualification.mjs::runRandomizedProducer` already
supplies these variables; no attempt number, policy, reference or authority is
created by this increment. Ordinary controls use an explicitly unqualified label
for their actual task invocation and retain a null plan context when none was
supplied. The root plan reference still comes from the actual original CLI plan.

## Exact remaining callback requests

The owned native source can now publish real structured failure metadata and
partial execution observations. The following inputs are still absent from its
actual callback API; the held semantic adapter continues to refuse without them.

- The original execution/assertion owner must supply explicit assertion IDs and
  generated case bindings, original attempt number/content digest and held
  replay/envelope/temporal references. `ITestFailed` exception metadata does not
  identify an assertion site or establish #2020 canonical failure identity.
  The existing test-only `ReporterMaterialTests.ObserveEqual` provides an explicit
  assertion ID only for that isolated fixture, not for native product tests.
- `tests/backend/Unit/BackendPropertyTests.cs::RecordCase` is currently called
  only after all assertions for that sample pass. Its `PublishExecution` runs
  only on success. The original property owner must emit a flushed generated-case
  callback before those unchanged assertions, using its actual stream seed,
  current index and original sample serialization/hash algorithm; then emit actual
  per-assertion success/failure and first-failure records while preserving rethrow.
  The record must retain original run/attempt/plan inputs from the child environment.
  The parent can then join the retained prefix to its actual terminal without
  reconstructing a failed input from messages or post-success case lists.
- `tools/test/run-replay-qualification.mjs::runRandomizedProducer` currently
  rejects nonzero/signal results before retaining its process result and
  `parseProcessEvidence` admits passing random observations only. Its original
  owner must expose the actual failure/cancel process terminal plus retained
  property callback references before throwing. This shared owner source is not
  changed here; the native parent is not substituted for its `dotnet test` lane.
- No shrink execution callback exists in the actual backend generator: its three
  configured streams have `shrinks=0`. `createFuzzCaseReceipt` accepts a supplied
  `failure.shrinkSequence` but does not execute or observe shrinking. A real fuzz
  owner must supply observed shrink/transition callbacks and retained minimal
  sample bytes if applicable; an empty or fabricated transcript is not emitted.

These are concrete producer/API gaps, not an OPEN-issue status dependency.
Canonical catalog/profile APIs remain usable from the pinned provider; actual
attempt/runtime authorities, canonical assertion emission and held partial
semantic acceptance remain with their original owners. No held substitution,
forgery, cross-candidate or tampering audits are run to bypass the existing hold.
