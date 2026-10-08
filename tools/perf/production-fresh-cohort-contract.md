# Production Fresh performance cohort contract

This is the contract for the owned standalone modules in this directory, linked to
issues #1941, #1942, #1943 and #1944. It does not register a new canonical scheduler,
collector, correctness authority, test inventory or Production finalizer.

The input is an explicit adapter contract, **not a native Production receipt**.
No machine cohort or runtime qualification has been manufactured in this change.
The native source adapter now consumes the exact CPU owner capability and the
canonical resource/noise validators. It projects available observed fields while
preserving missing qualification inputs. Its source projection is not a native
Production performance input, baseline or verdict. The existing observe-only
resource report cannot be promoted by renaming it or supplying a seal.

## Input and provenance

`production-fresh-contract.mjs` owns schema
`fsusblog.production-fresh.performance-input.v1`. Its fields are `schema`,
`digest`, `binding`, and five byte-bound evidence refs: `identity`, `execution`,
`resource`, `intervals`, `noise`. Each ref has exactly `locator` and `sha256`.
Locators are relative to one explicit artifact root. Symlinks, absolute paths,
traversal, empty components and `latest`/`current`/`active` aliases are rejected.
There is no directory discovery. Evidence must remain immutable throughout a
read; this API does not promise isolation from concurrent hostile file mutation.

The canonical JSON SHA-256 seal excludes only `digest`. All five evidence files
must repeat the exact binding: `runId`, positive integer `attempt`, and SHA-256
`sourceDigest`, `buildDigest`, `planDigest`. Source/build identify an execution;
they are retained in provenance rather than required to equal historical source
revisions. Baseline reuse requires exact machine, physical plan, fixture/test,
toolchain, policy and collector identity. `planDigest` is recomputed from the
complete `identity.values.physicalPlan` object.

`identity.values` has exactly the 17 exported `identityFields`. The exported
`identityRequirements` describes the mandatory facts: a physical `machineId` and
`topologyDigest`; calibration `receiptDigest`, `effectiveCpuUnits` and
`finiteBoundaryCpuUnits`; OS/kernel/libc; resource enforcement mode/policy;
power mode; reserved memory bytes; storage device/filesystem; toolchain, browser,
services, fixtures and test digests; collector version/source digest. The finite
CPU boundary cannot be exceeded. Identity fields may retain additional observed
facts; every such fact affects the recomputed identity digest. The calibration
receipt digest is a required adapter fact, not a claim that #1940 loader acceptance
has occurred.

`identity.values.policy` contains exactly positive `relativeTolerance` (less than
one), positive `benchmarkCvMaximum` and `dispositionDigest` equal to the exported
registry digest. These are upstream machine policy inputs, not newly calibrated
thresholds or a cross-machine CPU utilization gate.

Execution facts declare `mode`, `status`, `terminal`, `complete`, `resumed`,
`retryCount`, `plannedDigest`, `executedDigest`. Resource facts declare `complete`,
`health`, `metrics`, `steps`. Health includes numeric swap bytes, OOM and resource
kill counts, benchmark CV, and boolean thermal/isolation validity. Metrics name a
bundle/step, unique registered name, `measured | unsupported | unavailable` status
and a finite nonnegative value or **null**. Steps explicitly declare `cpuHeavy`
and `samplingComplete`. Actual CPU and integrated grant evidence remain distinct.

Noise facts declare boolean `valid`, `complete`, and nonnegative metric-unit
`floors`. Required baseline metrics need known machine floors. `intervals.items`
partitions the entire critical path with unique ids and ordered, positive,
nonoverlapping durations. Each interval references byte-bound state facts with
exact owner, time, interval and run binding. Wait reasons use the existing resource
collector's category vocabulary. Dependencies/exclusive/capacity/external I/O
require scheduler state, readiness requires marker state, productive work requires
actual CPU resource state, and quiet windows require exclusive scheduler state
plus valid noise/isolation. Conflicting or absent evidence is `unexplained` and
blocks evaluation. No classification is inferred from a bundle name or log text.

## Cohort capture and validation

`captureCohort` takes an explicit ledger, run locator list, previous `expectedHead`
and a new snapshot output locator. The first anchor is exported `ledgerGenesis`.
It requires at least three distinct successful Fresh, complete, clean first
attempts. Failure/retry/resume, partial resource/noise, swap/OOM/resource kill,
thermal/isolation/CV invalidity and exactness drift are rejected before append.
All selected valid samples are retained in order, including slower samples.

The ledger is one locked, append-only JSONL chain with sequence, previous entry
digest, identity, raw receipt ref and run id. Append verifies the externally
retained previous head; duplicate run ids and duplicate raw receipts are rejected.
Capture cannot overwrite a cohort snapshot. Writes are fsynced. An interrupted
partial append fails validation; it is not silently repaired. A crash after a
complete append and before snapshot publication requires explicit recovery of the
known ledger prefix by its owner; no scanning or automatic sample replacement is
performed. The caller must retain anchors outside mutable artifacts. Hashes alone
do not authenticate a producer or prevent rewriting both a ledger and its trusted
external anchor.

`inspectCohort` independently rereads all referenced raw files, recomputes binding,
eligibility and classifications, verifies ledger sequence and anchored prefix, and
recomputes complete distributions (all values, count, nearest-rank p50/p90, mean,
standard deviation and spread). A historical explicit snapshot remains usable
after legitimate appends. Capture/inspect output no performance verdict.

## Classification and comparison

`metricRegistry` is the sole standalone disposition registry. Every accepted
metric has exactly one declared gate or diagnostic role; applicability yields
`not-applicable`, and unsupported observations remain `unsupported` with null
values. Unknown metrics are rejected. Required unknown metrics, incomplete
CPU-heavy sampling, unexplained intervals or critical-path coverage gaps produce
`not-evaluable`. CPU efficiency is actual CPU / integrated granted CPU, applicable
only to CPU-heavy steps with complete evidence; it is diagnostic rather than an
independent improvement condition. Wait metrics and longest unproductive interval
are recomputed from authoritative classification.

`comparePerformance` reads exactly one current and one baseline locator. Exact
identity mismatch is `not-evaluable`. Swap/OOM/resource kill, invalid benchmark
CV/isolation or planned/executed drift veto the current run. Other invalid current
runs remain explicitly `not-evaluable`. Comparisons use the maximum of measured
current/baseline machine noise floors and baseline distribution spread. Regression
must exceed both relative tolerance and noise margin from p50 and lie beyond the
p90 noise envelope. Timing improvement must exceed relative and noise margins.
Any gate regression wins over timing improvement. Four terminal outcomes are
`regression | improvement | noise-only | not-evaluable`.

Each metric diff retains owner, interval id where applicable, complete baseline
distribution, current value/status, floor, relative delta, disposition, relation
and reason. Zero-baseline relative delta is null while absolute movement can still
exceed the measured floor. CPU burners cannot override wall-clock or wait
regression. Legitimate quiet/I/O/non-CPU phases do not receive a CPU threshold.
Comparison has no retry, scheduling, ledger mutation or qualification writes.

## Native source coupling

`production-fresh-native-adapter.mjs` consumes the unchanged CPU capability lineage
at `3726bae1d1fc3b0969850c90342ef16f7bfb8a2a` from PR #3948. This tested successor to
`36814eb82be4b53611277d832908eb8201f73fd1` supplies
`validateRunCpuCapacity(selection, { topology, identity })`, including immutable
calibration/cohort reference revalidation. The adapter consumes a previously
selected, byte-bound capacity receipt. It does not call `resolveRunCpuCapacity`,
change capacity, activate a pointer or reload mutable active state during a run.

`projectNativeCpuCapacity` accepts `root`, explicit `topologyRef`, `selectionRef`,
`planRef`, `expectedBinding` and `expectedCpuIdentity`. It validates with the CPU
owner's API, checks the run and physical plan digest, and projects the observed
machine/topology, calibrated receipt/capacity/finite boundary, kernel, power and
CPU-bound fixture/test/toolchain identities. The run-specific selection digest
stays in provenance rather than the reusable baseline identity. Fallback remains
uncalibrated and not baseline eligible. Immutable calibration references are
retained; the upstream semantic-seal verification remains the CPU owner's rule.

`bindPerformanceIdentityToNativeCpu` additionally takes all 17 `identityValues`
from the performance identity producer. It replaces CPU-owned fields with the
verified native projection, checks OS platform agreement, retains the non-CPU
supplement and outputs the existing `{ binding, values }` identity facts plus
native CPU provenance. It refuses fallback. OS version/libc, storage, memory
reserve, browser/services, collector and policy still require actual non-CPU
observations; the adapter does not fabricate them.

`production-fresh-native-cpu-binding.mjs` is the pure CPU binding/verification
owner, separate from collector imports. `loadPerformanceRun` revalidates native
CPU provenance whenever a native CPU identity is present, rereads the original
byte refs, calls the original capacity validator and recomputes every projected
CPU identity field. Removing provenance or resealing a normalized CPU field
cannot bypass this validation. This pure dependency introduces no process spawn
into the existing verdict consumer.

`projectCanonicalResourceState` takes `root`, `resourceRef`, `checkpointRef`,
`planRef`, `expectedBinding`, `expectedSourceState`. The binding source digest is
the native source worktree fingerprint without its `sha256:` prefix. It invokes
`validateResourceUtilizationBinding`, verifies the exact checkpoint bytes/run/
source/revision, compares canonical critical-path and wait projections, rereads
all byte-bound bundle fragments, and compares their original step projections.
It independently integrates each raw grant history using
`integrateResourceGrantHistory`. Null and unsupported collector values remain
null even if an older display aggregate coerces them to zero. CPU-heavy complete
sampling requires native kernel descendant accounting and complete grant
integration; reserved CPU cannot substitute for actual CPU.

The physical plan must contain an exact executable `steps` roster with explicit
`bundleId`, `stepId`, `cpuHeavy`, `schedulerOwnerId`. No scheduler owner is inferred
from a name. Wait projections retain their original category/detail/time, exact
checkpoint ref and JSON pointer, scheduler authority and explicit mapped owners.
A bundle wait cannot be assigned to one guessed critical-path step. A readiness
wait retains `needsMarkerAuthority`; it is not relabeled as a native marker event.
Quiet/isolation evidence is not silently made valid. Full-run peak RSS/PSI,
swap/OOM/kill, thermal/CV/isolation and first-attempt terminal facts are explicitly
listed as unavailable required inputs where the canonical report does not provide
their complete authority.

`projectCanonicalNoise` takes explicit `sequenceRefs`, `policyRef`, `windowId`
and `expectedBinding`. It calls the original policy and authority-sequence/
terminal validators, checks run/attempt, and preserves raw observations and refs.
A clean window does not create calibrated metric noise floors. Missing floors
remain null. These APIs perform upstream source projection and must not be
imported by the zero-producer finalizer; the original resource module initializes
its native clock-tick probe when imported.

`inspectNativePerformanceSources` composes those verified projections and emits
`fsusblog.production-fresh.native-performance-source-projection.v1`, always
`not-evaluable` and not baseline eligible while complete native health, critical
interval, current-attempt terminal and calibrated noise-floor capabilities are
missing. This output is deliberately rejected by the existing performance-input
schema. It supplies reusable, independently inspectable source facts and precise
remaining producer requirements rather than a fabricated native receipt.

## Independent verdict consumer

`createPerformanceVerdict` is a separate producer. It binds an explicit terminal
comparison receipt to the expected current execution binding and maps improvement
and noise-only to `pass`; regression and not-evaluable stay blocking. The terminal
verdict retains current, baseline and comparison byte refs plus reasons and an
explicit reproduction argument vector.

`consumePerformanceVerdicts` is the read-only consumer for #1933. Call it with
`root`, **exactly one trusted catalog `verdictRefs` entry** (`locator`, `sha256`),
`expectedBinding`, and optionally the unchanged `correctnessFailure`. It verifies
the verdict and comparison seals/bindings/byte refs and their exact projection.
It imports no comparator producer and never spawns a process. Missing, duplicate,
provisional, tampered, wrong-attempt or divergent verdicts block qualification.
Not-evaluable becomes `calibration-required/not-evaluable`. Correctness remains
the first failure when both fail. The finalizer owns the trusted catalog binding;
a self-chosen hash is not producer authentication. Consumer validation does not
rerun comparison, capture, classification or baseline discovery.

## Commands

Create the artifact directory explicitly first. All example run locators are
placeholders for verified adapter outputs; fixture runs are not native evidence.

```sh
node tools/perf/production-fresh-cli.mjs capture --root /explicit/run-artifacts \
    --ledger baseline-ledger.jsonl --expected-head HASH --out cohort-001.json \
    --run run-a.json --run run-b.json --run run-c.json
node tools/perf/production-fresh-cli.mjs inspect --root /explicit/run-artifacts \
    --baseline cohort-001.json
node tools/perf/production-fresh-cli.mjs compare --root /explicit/run-artifacts \
    --current-run current-run.json --baseline cohort-001.json --out comparison-001.json
node tools/perf/production-fresh-cli.mjs verdict --root /explicit/run-artifacts \
    --comparison comparison-001.json --binding expected-binding.json --out verdict-001.json
node --test tests/tools/production-fresh-cohort.test.mjs \
    tests/tools/production-fresh-comparator.test.mjs
```

CLI exits: successful capture/inspect/pass/improvement/noise-only `0`, terminal
regression `1`, not-evaluable or invalid input `2`. Output files are new and cannot
replace earlier immutable evidence. The comparator API itself is read-only; the
explicit CLI output is its caller-owned new receipt.

## Remaining acceptance and owner contracts

- #1941: capture/validator plus native CPU identity binding are implemented and
  consume the exact #1940 capacity validator. Complete native health, first-attempt
  terminal and calibrated noise-floor inputs remain missing. At least three actual
  eligible Fresh runs have not been captured.
- #1942: closed registry/classifier and canonical raw collector/grant/wait source
  projections are implemented. Complete critical-path partition and dedicated
  marker/isolation/full-run resource authorities still need canonical producer
  integration and real sampling acceptance.
- #1943: read-only comparison and four outcomes are implemented; native source
  projection verifies the existing CPU/resource/noise API coupling. Native complete
  current/cohort evidence and independent exact-candidate recomputation acceptance
  remain open; source fixtures do not certify hardware qualification.
- #1944: verdict producer and zero-producer consumer controls are implemented.
  #1933 owner must wire the consumer into its required terminal catalog/summary,
  and #1686 owner must register applicable matrix/release inputs. Production
  summary currently has not been changed and observe-only runtime authority is
  not silently promoted. Canonical workflow/lifecycle attachment of these new
  tests remains with the shared registry owners.

Rollback removes these standalone modules and their owning controls. No existing
scheduler/collector/finalizer authority or historical evidence is rewritten.
