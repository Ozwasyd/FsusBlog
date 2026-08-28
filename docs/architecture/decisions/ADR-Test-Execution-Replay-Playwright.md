# ADR: Playwright replay uses repository-owned sealed lanes

Status: Accepted
Date: 2026-08-26
Issue: #2003

## Context

Playwright 1.59.1 exposes test begin/end and result worker identities to
reporters, but it does not expose a supported callback that accepts an ordered
queue before runner dispatch. `onTestBegin` is emitted after the runner has
already assigned a test group to a worker. Completion order changes under test
delay and worker restart, so neither reporter event can prove the requested
pre-dispatch order.

The repository needs to execute a sealed list without reducing ordinary test
parallelism or patching Playwright internals. The decision must preserve the
current project, fixture, global setup, retry, artifact and cancellation
semantics.

## Decision

FsusBlog uses one repository-owned orchestrator with `N` concurrent lanes.
Each lane starts a separate public Playwright CLI process with:

- an explicit `--test-list` containing only that lane's sealed canonical test
  membership;
- `--workers=1`, while the outer orchestrator requires more than one lane for
  the ordinary parallel topology;
- the current project/config, retry policy and a lane-owned artifact root;
- a repository-owned pre-dispatch record written before the child starts.

The outer plan owns the ordered lane queues. The adapter does not infer
dispatch from `onTestBegin`, `onTestEnd` or reporter completion order. A worker
restart changes the child receipt's worker identity but not its stable lane
identity. Topology 1 is supported only as a separate qualification plan;
topology 2 and the planned topology retain real concurrent execution.

When session isolation is enabled, the orchestrator runs the existing
`prepare-playwright-sessions.mjs` once for the total lane count and sets
`FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP=1` in children. This preserves the
existing global setup effect without racing one setup per child. The current
configuration has no global teardown. Any future global teardown or project
dependency change invalidates the decision digest and fails before dispatch.

The orchestrator owns cancellation. A lane failure aborts sibling process-tree
owners, waits for zero residual members, and retains the first failed lane and
its artifacts. Automatic retry cannot overwrite the first attempt.

## Rejected alternative

A maintained Playwright scheduling API was rejected for 1.59.1. The public
package exports the runner, reporter and CLI surfaces, but no API accepts sealed
per-slot queues or emits a pre-dispatch event. Reporter callbacks expose an
already-dispatched `TestResult`, including `workerIndex` and `parallelIndex`.
Using private dispatcher modules would couple correctness evidence to unstable
internals and has no maintenance contract.

## Adapter contract

Inputs are the sealed plan and decision receipt, exact test IDs and shard
memberships, lane count, project/config identities, retries, fixture/global
setup digest and artifact root. Outputs are one actual pre-dispatch event per
test, lane/child/worker restart identities, process outcome, artifacts, cleanup
evidence and an exact plan binding.

The adapter fails before starting children for decision, Playwright version,
config, global setup, membership, digest or topology drift. It fails after
execution for missing/extra/duplicate tests, lane/worker drift, incomplete
cleanup, retry overwrite or artifact ownership drift.

## Migration boundary

Only Playwright correctness producers use this adapter. Diagnostic Playwright
lanes keep their existing configuration and cannot satisfy replay
qualification. Replacing the adapter requires a new accepted ADR and decision
receipt; a version upgrade does not silently select another architecture.
