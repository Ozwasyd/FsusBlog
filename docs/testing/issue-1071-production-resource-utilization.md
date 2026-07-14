# Production resource utilization evidence

`./tools/test.sh production --fresh` writes the canonical observe-only report to
`.tmp/release-evidence/production-resource-utilization.json`. The report is bound to the scheduler run ID,
source commit and worktree fingerprint, machine envelope, checkpoint revision/digest, physical bundle summaries,
and their resource fragments. A failed or cancelled run still writes available data with `status: "partial"` and
`incomplete: true`.

## Metric definitions

- `actualCpuSeconds` is user plus system CPU time. On Linux, GNU `time` provides kernel rusage for a completed
  command and its waited descendants, while `/proc` samples provide the time curve and live process-tree details.
- `grantedCpuSeconds` is the piecewise time integral of every live CPU grant. It is never calculated by multiplying
  the final grant by total wall time. `cpuGrantEfficiency` is actual CPU seconds divided by that integral.
- `peakRssBytes` combines kernel exit rusage with live samples; `averageRssBytes` is the sampled time-series mean.
  `readBytes` and `writeBytes` use `/proc/<pid>/io`. GNU `time` filesystem block counts are not mislabeled as bytes.
- Context switches come from kernel rusage. `processSpawnCount` is explicitly marked `sampled-lower-bound` until a
  cgroup process-event counter is available; it is not presented as an exact zero when a short process is unseen.
- `idleCapacitySeconds` is the scheduler CPU envelope integral minus attributed step CPU. Scheduler curves retain
  runnable queue depth, load, reserved CPU/memory, and host memory pressure.

Reserved CPU is an admission promise, not measured utilization. A bundle can reserve every CPU while waiting on a
marker, dependency, database, filesystem, browser lock, or internal serial section. Saturation claims must therefore
use actual CPU and wait evidence together, never `reservedCpuUnits` alone.

## Waiting and attribution

Wait intervals have one category at a time: `readiness-marker-blocked`, `dependency-blocked`,
`benchmark-isolation-cooldown`, `exclusive-resource-blocked`, `capacity-blocked`, or
`external-service-io-blocked`. Readiness and dependency state take precedence over resource admission so the same
wall interval is not counted twice. Exclusive waits retain the resource name.

Each normal step runs as its own detached process group. `/proc` walks that group tree at a machine-derived low rate;
benchmark-window steps use a one-second-or-slower interval derived from the granted CPUs. GNU `time` exit rusage retains CPU, peak RSS, and
context-switch totals after descendants exit, including abnormal exits. Collector CPU time, sampling count, interval,
and collection nanoseconds are written beside every step so benchmark disturbance can be compared before and after.
The canonical report also records a post-run machine-local calibration: a timing-only baseline and the same iteration
count with `/proc` tree reads, including added nanoseconds per sample. This proves observer cost without sampling inside
the benchmark's measured inner loop.

## Platform and sampling limits

Linux is the authoritative detailed collector. If `/proc`, GNU `time`, or a metric is unavailable, the field is
`null` with `unsupported` or `unavailable` status; the implementation never substitutes zero. Live RSS and I/O curves
have sampling error, and a very short descendant may be absent from the sampled spawn lower bound even though its
kernel rusage remains in completed-command totals. Other platforms retain wall/grant evidence and explicitly degrade
unsupported process metrics.

The first phase is observe-only: utilization thresholds do not fail release. Binding corruption, mismatched run/source
or checkpoint identity, and malformed evidence do fail closed because mixing two runs makes measurements meaningless.
