# Fixture matrix evidence integration contract

This source-stage contract accompanies issues #2571 and #2665. The sole runtime
scheduler, matrix, fixture catalog and orchestrator retain execution authority.
These modules validate supplied materials; they do not execute fixtures, construct
a producer DAG, repair state or issue runtime qualification.

## Switch evidence

`tools/test-matrix/fixture-switch-evidence.mjs` consumes
`fsusblog.fixture-switch-projection.v1`. This is an **unbound integration request**
to #1720/#2664, not an existing scheduler output. The projection must supply:

- The single producer ID `fixture-profile-mutation-conformance`.
- Exact ordered profiles: public-minimal, auth-basic, comments-moderation,
  messaging-preferences, public-empty.
- Current run, namespace, provider, source commit/worktree, build, matrix,
  profile catalog, mutation catalog and temporal context identities.
- Backend PID/start/build and matching DB/Redis instance/service-generation
  identities. All events must preserve these identities.
- Per-profile producer/capability/variant plan digests, exact catalog envelope
  IDs and explicit node IDs for admit, prepare, verify, mutation, reprepare,
  recovery, cleanup, transition. Public-empty replaces the three mutation phases
  with empty. The projected hard edges must connect every consecutive node.
- Exclusive backend/database/Redis/filesystem resources and exact state domains.
  The scheduler owner must bind these declarations to its actual conflict API.

`bindFixtureSwitchPlan` checks the supplied projection and its catalog applicability.
It does not select envelopes or generate topology. Missing messaging, media-provider
and comment-timeline support in the current catalog is reported by
`inspectFixtureSwitchCapability`; it cannot be converted into a provider skip.

`buildFixtureSwitchEvidence` consumes this plan/projection, chronological scheduler
events and a content-addressed material map. Each material binds its phase, profile,
context and exact declared operation. Recovery material carries the existing
`runMutationRecovery` plan/receipt and is checked through its canonical verifier.
Cleanup material must name fixture-orchestrator ownership, settled completion,
zero owned residue and unchanged observations of both nonowned sentinel domains.
Public-empty material requires explicit zero records/keys/files/sessions in all
auth/comment/message/preference/public domains in the current namespace.

Failed/cancelled/timed-out sequences preserve their primary status and require a
settled cleanup terminal. All remaining profile phases become blocked. Reordered,
overlapping, missing and extra events fail; next-profile admission after failure
fails. Terminal evidence is independently recomputed by
`verifyFixtureSwitchEvidence`. No event or receipt is selected by latest or mtime.

The source-stage evidence always has `qualificationEligible: false`. Exact
upstream admission, cleanup and empty-observation verifier APIs are still missing;
matching caller-supplied digests are integrity checks, not independent observations.
The #2567/#2570 owners must supply messaging session/notification/preference,
comment timeline and mixed DB/filesystem recovery capability before the fixed
sequence can run. No existing runner or catalog is replaced here.

## Matrix governance

`tools/test/fixture-matrix-governance.mjs` supplies conservative source scanning,
bidirectional roster comparison and recomputable terminal reports. The scanner
inspects tracked and nonignored candidate text via
`tools/test/check-fixture-matrix-governance.mjs`, covering shell, Node, C#,
workflow, documents and configuration. Rules identify default/tier/env inference,
second mapping/DAG, old parser, hidden prepare, data-scale fallback, diagnostic
reuse, admission bypass, latest evidence and sequence restart. It does not parse
every language; matches are review candidates, and documented examples become
explicit warnings. No wildcard allowlist or automatic repair is provided.
The CLI also consumes `validateFixtureAuthoritySources` from the existing canonical
fixture catalog module for alias/second-authority enforcement. It does not copy
that owner's alias vocabulary or allowlist into this scanner.

The exactness API consumes five independent rosters: matrix declarations, compiled
bindings, consumer admissions, actual local observations and actual CI observations.
Every row supplies step/profile, test IDs, capabilities, producer IDs, lifecycle
node IDs and admission digest. Missing/extra/orphan/duplicate or drifted entries
fail. These proposed roster inputs are not replacements for canonical inventory,
compiler or scheduler authority.

Terminal evaluation requires all ten named mutation results and all seven identity
invalidation dimensions. A mutation must have a current-source identity, nonzero
command exit, input/output digests and diagnostic observations. Invalidation must
show distinct before/after identity digests and rejection of the old plan, cache,
evidence and release candidate. Unknown/not-observed/skipped results cannot pass.

`buildFixtureMatrixAcceptance` emits `fsusblog.fixture-matrix-acceptance.v1`
with status `blocked`, warnings and pass/fail/unrun checks. Even supplied #2663 and
#2664 receipts remain unrun until the owners provide exact source-bound receipt
schemas and independent verifier APIs. A receipt's self-seal cannot authorize
acceptance. `verifyFixtureMatrixAcceptance` rejects material tamper and resealed
status promotion by recomputing the report.

Run the actual scanner with:

```sh
node tools/test/check-fixture-matrix-governance.mjs --write
```

The output is `.tmp/test-evidence/fixture-matrix-acceptance.json`; blocked output
returns exit 1. The new tests use explicitly DATA_ONLY hypothetical materials and
cannot qualify any backend/provider. They exercise rejection contracts, not the
listed issues' runtime acceptance. #1686 retains registration of the new tests and
producer into canonical matrix/inventory. This increment does not edit those files.

## Available runtime port consumers

The owned `fixture-switch-scheduler-adapter.mjs` consumes the canonical checkpoint
read API and, when explicitly requested, the current correctness receipt reader.
It also consumes version 1 `verifyCommittedSchedulerEvidence` from exact published
source `442cc6bd979c88b6af4a3fbe63583af61f4768bd`. Callers must supply exact run, source,
build, attempt, checkpoint digest and journal sequence references. Reads use the
strict read-only canonical API, check unchanged canonical readback and optionally require the
completed scheduler owner's current terminal receipt. No CAS, finalizer, new
receipt writer, history lookup or runner is introduced. The source-evidence binding
recomputes the existing switch materials and links their run/source/build to this
snapshot. It does not assert that caller-supplied lifecycle events were admitted
by the scheduler; the missing compiled phase authority stays explicit.
Committed readback requires the independently expected post-commit revision,
current-run context, registry and explicit registry entry, repository root and
payload schema. The adapter captures caller identities before its first await and
uses the same absolute checkpoint path for both readers. It preserves the actual
committed revision, wrapper reference and serialized wrapper digest separately
from the payload digest; an evidence attempt is not relabeled as an aggregate
target attempt. A running checkpoint does not become terminal through readback.
Both canonical raw-hex and current-run prefixed SHA-256 source fingerprints map
to the switch contract's prefixed form, while the original scheduler binding is
retained unchanged. This prevents a second prefix on current-run identities.

`CommentFixtureTimelineSequenceAdapter` consumes the mutation port from
`6656a73e5588f09e11f1320c43ca3f8fd153c7e3` and delivery observation port from
`86b02bc431251901d3ebba0306a371903b1d0bf7`. It invokes each caller-supplied command
once, immediately reads its delivery observations once, and requires exact identity,
references, business time, expected revision/status/timeline head and continuity
between the previous after-state and next before-state.
The before/after moderation events are checked by that source's canonical
`CommentFixtureTimelineVerifier.IsContinuous(events, currentStatus)` rather than
reconstructing moderation rules locally. The delivery port now owns full bounded
queue and reply-page traversal; its serialized `AdminQueueFirstPage` name stays
unchanged. This adapter adds no paging implementation or reader.
Plans and their command
tokens are excluded from returned evidence. A failure retains completed steps,
the pending successful mutation and its primary exception for scheduler-owned
cleanup; no cleanup, retry, query implementation or delivery drain is added.
Public projection and outbox exact revision, native qualification and bounded
delivery acceptance remain gaps even if all returned queue rows are processed.

These dependency sources are not yet on this partition's source base. Integration
requires their exact APIs; absence is a dependency failure, never a skipped pass.
The new bounded Node controls use existing controlled current-run publication and
canonical read APIs. They do not invoke the terminal finalizer, phase, recovery,
cleanup or cohort controls. The optional current terminal reader still requires
its separate matched terminal-owner source; it is not supplied by the committed
readback increment and is not exercised in this continuation. Backend controls
use the actual typed port interface with read models. Both are ordinary source
verification and cannot establish runtime acceptance.

## Remaining owner handoffs

- #1720/#2664: exact compiled projection, actual admission/cleanup/empty observation
  references and independent verifier API; local/CI observed roster handoff.
- #2567/#2570: missing semantic envelopes and multi-resource recovery support.
- #2663: exact cleanup receipt schema and independently verified source inventory.
- #1686: canonical registration and source/history/output binding for the new tests.

Independent review, merge and issue closure remain with the integration owner.
Rollback removes this owned source increment; it changes no product data or runtime.
