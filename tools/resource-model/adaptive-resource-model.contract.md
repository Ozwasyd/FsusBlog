# Adaptive resource candidate contract

This directory implements DATA_ONLY candidate algorithms for issues #1945–#1949.
It does not supply a Production qualification authority. The actual scheduler,
performance verdict, canonical inventory, matrix and historical ledgers retain
their existing owners. No speedup or real runtime qualification is claimed.

## Evidence and ledger

`createSampleCandidate` takes an explicit evidence root and eight exact relative
JSON locators (`ref`, canonical JSON `digest`): run, plan, resource, performance,
collector, enforcement, benchmark and noise. Each observation input has schema
`fsusblog.adaptive.observation-input.v1`, `authority: DATA_ONLY`, a matching role,
run/attempt and identity. These are owned **input contracts**, not invented
upstream receipt formats. Digests use the existing `digestJson` export from
`tools/perf/app-config-catalog.mjs`, available on source base
`53da546cc8ab9fd8603067395d988b7ddb650394`.

The six identity fields bind a particular machine instance, physical plan,
producer membership, effective capacity, metric schema and test membership.
Digests of sorted producer and test IDs are independently checked. All raw refs
are retained. Missing facts fail closed; unsupported required metrics, failed,
cancelled, retried, resumed, partial, uncalibrated, noisy, mismatched or
resource-invalid observations cannot enter even the candidate ledger.

Run facts require passed correctness, fresh/non-resume, complete calibrated
first attempt. Resource facts require complete evidence, zero unsupported
required metrics, swap, OOM and kills, and exact per-producer observations.
Performance facts require evaluable, terminal pass. Collector/enforcement facts
require completeness and no drift; benchmark facts require valid isolation/CV;
noise facts require explicit false thermal/external invalid markers. Observation
metrics and classifications are enumerated and validated in `sample-ledger.mjs`.
Optional GC/allocation pressure is a nonnegative number or explicit `null`.

`appendSampleCandidate` writes immutable ordinal records under a directory lock.
An explicit caller-held `{count, digest}` is the chain anchor; preserve the
returned head outside the ledger and supply it to every read/append. This detects
mutation and truncation relative to that anchor. It cannot authenticate a caller
that replaces both the entire ledger and its trusted head. No filesystem scan,
mtime, latest alias, ledger pruning or slower-sample replacement occurs. Same-run
reuse, including a copied raw receipt or different attempt, is refused.
Publication uses a synced temporary record plus non-replacing hard link. A crash
after record publication can leave an unacknowledged ordinal; a subsequent stale
head append refuses replacement. Recovery requires the ledger owner to verify
that exact record and recover its head, never overwrite it or steal a stale lock.

## Read-only recommendations

Every generator rereads the ledger and revalidates its raw receipts. Inputs
include held canonical producer defaults and the exact capacity object whose
digest is bound by the identity. No generator modifies those defaults.

CPU uses median actual/granted utilization, grant efficiency, critical membership,
capacity blocking, wait class and throttling. Dependency/readiness waits and
throttling veto weight changes; benchmark/quiet steps are protected. Efficient
critical CPU work may increase relative weight; I/O work may reduce elastic
weight. Changes are clamped to 20%, require five samples and confidence ≥0.8.
Safe checked-in minima are retained: observations alone do not prove a lower
admissible minimum. Minima must fit the held minimum-supported CPU capacity.
Elastic grants are normalized inside the unchanged effective envelope, with
benchmark grants fixed to the held default `cpuUnits`.

Memory uses a 90th RSS quantile after upper-tail winsorization at the empirical
80th-percentile order statistic, a 30% safety margin and 20% update clamp.
Five samples and confidence ≥0.8 are required. PSI, major faults, GC/allocation
pressure veto shrinking; unknown/mixed attribution holds the full default grant.
Resident reservations count once; step and unknown reservations use the exact
held `maxConcurrentInstances` bound. Conservative simultaneous demand plus
`max(absoluteReserveFloorGiB, totalMemoryGiB * proportionalReserveFloor)` must fit.
This intentionally refuses schedules that need a finer non-overlap proof. The
capacity owner must include candidate CPU concurrency changes in the held
capacity identity; this module cannot derive scheduler concurrency authority.

Startup checks every dependency, sealed marker, CPU/memory, exclusive, filesystem,
state/output conflict and benchmark condition before scoring. Scores use robust
unlock, startup latency/cost, critical membership, capacity wait and queue history.
Learned benefit is bounded at 100; deterministic queue age grows one point per
second, so a continuously eligible waiting producer eventually overtakes a new
arrival with finite default priority. Low confidence keeps held default priority.
Identifier order breaks ties; no name patterns or total-duration rank are used.
The hard-ready facts remain scheduler inputs, not independent readiness proofs.

## Model lifecycle

`createModelBundle` retains all sealed recommendation documents and their digests,
defaults, ledger head and learning run IDs. Identity, membership, benchmark grant
immutability, CPU and concurrent memory feasibility are independently rechecked.
`shadowModel` is a pure decision projection: it emits actual/would-grant/admission
rank differences and cannot invoke scheduler admission. Benchmark CPU and memory
remain unchanged in shadow. No model changes DAG, test membership or thresholds.

`evaluateActivationCandidate` requires an exact shadow and at least three distinct
fresh first-attempt confirmation runs outside the learning-run set. Every
confirmation has explicit raw performance ref/digest and matching identity,
model/shadow digest. Matching baseline/current correctness, test, coverage and
measurement digests are required. Candidate activation needs p50 gain ≥5% unless
all recommendations honestly preserve defaults; p90 must not worsen, and memory,
isolation and CV guardrails must pass. These are mechanical DATA_ONLY checks;
independent upstream authority remains required for actual activation.

`publishCandidatePointer` and `rollbackCandidatePointer` exercise the local
candidate lifecycle with a directory writer lock, expected-pointer-digest CAS,
immutable retained model files and terminal records written before atomic rename.
The file is deliberately `candidate-active.json`; no Production consumer reads
it. Reject and no-change paths retain terminal records without switching it.
Readers see a complete old/new pointer. Failed pre-rename publication leaves the
old pointer intact. A post-rename sync failure may have committed the new pointer;
recover by explicit pointer inspection/CAS, never assume rollback. Stale locks
refuse writers. Old model files and terminal records are retained.

`selectCandidateModel` rereads disk on each pre-plan-seal selection and returns a
deeply frozen snapshot. Corrupt/missing model or terminal, identity/default drift,
low confidence and infeasibility return an immutable copy of the caller's held
checked-in defaults. Selection after seal is refused. There is no online learning,
cached corrupted model, automatic Git commit, cloud/LLM authority or cross-machine
sharing. The canonical scheduler must supply its actual checked-in defaults;
this module does not introduce a competing global default registry.

## Commands and integration gaps

The CLI accepts one explicit input JSON file and optional non-replacing output:

```bash
node tools/resource-model/cli.mjs cpu --input /tmp/adaptive-cpu-input.json --out /tmp/adaptive-cpu-output.json
node tools/resource-model/cli.mjs rollback --input /tmp/adaptive-rollback-input.json
node --test tests/tools/adaptive-resource-ledger.test.mjs tests/tools/adaptive-resource-cpu.test.mjs tests/tools/adaptive-resource-memory.test.mjs tests/tools/adaptive-resource-startup.test.mjs tests/tools/adaptive-resource-lifecycle.test.mjs
```

Input JSON fields match the exported function signatures. Commands are sample,
append, ledger, cpu, memory, startup, bundle, shadow, evaluate, publish, rollback,
select, production-enroll and production-activate. Unknown/duplicate arguments
and missing input fail. All terminal outcomes remain DATA_ONLY.

`enrollProductionSample` and `activateProductionModel` always reject with
`upstream-verification-unavailable` until the independently held #1944 bridge is
actually delivered and reviewed. A caller `verified` flag or callback cannot
enable them. Required handoffs are: #1944's terminal verdict verifier and raw
resource/calibration binding; the scheduler owner's pre-seal read-only selection,
held defaults, fixed benchmark windows and proven hard-ready/concurrency envelope;
the #1686 owner's canonical test/matrix registration. Actual clean Production
samples, independently confirmed performance runs, scheduler shadow integration,
runtime defaults and full required matrix evidence remain unverified.

The #1944 owner has now published source capability
`89b27fe9557c3b16948a61b7f58b997537f31fb9` in draft PR3960. The exported
`inspectPerformancePrerequisite` accepts an explicit source `capabilityRoot`,
byte-checks the two complete verdict/contract dependency files against that exact
commit, and calls the original `consumePerformanceVerdicts` with its native
`{root, verdictRefs: [{locator, sha256}], expectedBinding, correctnessFailure}`
API. This preserves upstream byte locators and binding rather than translating
them into the DATA_ONLY observation-input format or reimplementing verdict logic.
Missing or drifted source refuses consumption. Each call rechecks bytes even
when Node has cached the module. The returned projection remains DATA_ONLY with
`nativeEnrollmentEligible: false`: upstream adapter validation is usable source,
but independently held native resource/calibration binding and Production
catalog/scheduler consumption remain missing. Neither upstream source nor its
tests are copied into this partition or its draft PR.
