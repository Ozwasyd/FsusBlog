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

## Remaining owner handoffs

- #1720/#2664: exact compiled projection, actual admission/cleanup/empty observation
  references and independent verifier API; local/CI observed roster handoff.
- #2567/#2570: missing semantic envelopes and multi-resource recovery support.
- #2663: exact cleanup receipt schema and independently verified source inventory.
- #1686: canonical registration and source/history/output binding for the new tests.

Independent review, merge and issue closure remain with the integration owner.
Rollback removes this owned source increment; it changes no product data or runtime.
