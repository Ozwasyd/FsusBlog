# Backend Production topology calibration

This diagnostic uses `tools/test/run-backend-production-shards.mjs`. It treats concurrent testhosts, per-host processor allocation, and rolling partition count as independent dimensions. The planner uses live admitted CPU/memory, discovered class/affinity planning units, cold application/testhost and class startup penalties, Docker/PostgreSQL weighted dependencies, and a hard limit of 12 testhosts. CPU allocation must equal the current grant; memory is split evenly with at least 1 GiB per host. Affinity classes remain indivisible. Requirement/evidence governance enters the same exact-union and coverage shards as ordinary tests; no postlude partition or testhost is added.

## Reproducible diagnostics

Full sweep:

```bash
node tools/test/calibrate-backend-production-topology.mjs --fresh
```

Run one candidate first to check environment and cost:

```bash
node tools/test/calibrate-backend-production-topology.mjs \
  --fresh \
  --candidate h4-p2-uniform \
  --repeat 3 \
  --max-candidates 1
```

Candidate IDs are `h<testhost>-p<partitionMultiplier>-<uniform|weighted>`. The default matrix uses testhosts `2/4/6/8/12`, partition multipliers `1.5/2/3`, and `uniform/weighted` allocation, clipped to local CPU, live free memory, the 1 GiB-per-host minimum, and planning-unit count. Each candidate requires at least three Fresh runs; `--repeat 1/2` is rejected before startup. `--cpu-budget` cannot exceed process-visible CPU and `--memory-gib` cannot exceed host memory. These options only narrow diagnostics; they cannot expand machine capacity or grant unauthorized resources.

Every sample runs the complete `./tools/test.sh production --fresh`; before the next, the runner removes that sample's production checkpoint, backend TRX/coverage, and release evidence. Calibration output cannot feed logical-tier projection, coverage thresholds, or release evidence. A selected candidate then requires a separate ordinary Fresh Production for deliverable evidence.

## Evidence contract

The default report is `.tmp/diagnostics/backend-topology-calibration.json`, schema `fsusblog.backend-topology-calibration.v1`. It binds full source commit, SHA-256 clean-worktree fingerprint, platform/architecture, and machine CPU/memory; source drift during execution fails closed. Each candidate retains at least three samples, wall-clock median/p25/p75/mean, variance/standard deviation, discovery summary, actual topology, per-partition duration, slowest partition, exact-once status, and GNU `time -v` child-tree user/system CPU, peak RSS, context switches, and filesystem I/O when available.

Prefer `/usr/bin/time -v` on Linux. The runner records testhost process start; TRX `startTime`/`endTime` supplies first-test-start and execution span. Unparseable values must be `status=unavailable`/`null`, never fabricated as `0`. Current PostgreSQL wait is explicitly unavailable; later canonical resource-utilization evidence owns process-tree sampling and wait categories. The report is `success` only when all samples succeed; failed candidates retain all collected samples to expose multiple failures at once.

## Overrides and rollback

- `FSUSBLOG_BACKEND_PRODUCTION_SHARDS`: diagnostic testhost count satisfying CPU, memory, planning-unit, and 12-host limits.
- `FSUSBLOG_BACKEND_PARTITION_MULTIPLIER`: rolling partition multiplier, at least `1`.
- `FSUSBLOG_BACKEND_PROCESSOR_ALLOCATION_MODE`: `uniform` or `weighted`; both conserve the CPU grant exactly.
- `FSUSBLOG_BACKEND_SHARD_PROCESSORS`: legacy uniform exact override; reject execution when its sum differs from the CPU grant.

None is a production constant. Clearing variables returns to the machine/workload automatic planner without code changes or test-result reuse. A dynamic grant may add only testhosts within the latest remaining CPU/memory. Each ordinary rolling slot rereads the grant before claiming another partition and counts the currently executing partitions. Contraction retains admitted children but pauses pending claims until their CPU and memory costs fit; invalid grant observations prevent further claims and drain active children before failing. The existing explicitly enabled I/O bridge remains a separate policy and is not strict parent-budget conformance.

`node --test tests/tools/live-grant-adapter-admission.test.mjs` exercises these admission boundaries with genuine gated Node child processes and exact child output ownership. It covers growth before active child terminal, CPU/memory contraction, invalid current grants, child failure and cleanup. These adapter regressions are not real .NET testhost/TRX/coverage equivalence or the four-executor `live-grant-uptake-receipt`; those require the canonical scheduler timeline and actual product executors.
