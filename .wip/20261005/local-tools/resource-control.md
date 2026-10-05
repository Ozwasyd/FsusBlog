# Local task resource admission

User instruction: control concurrency and avoid OOM. This supersedes the earlier
request to maximize parallel execution; the delivery objective remains unchanged.

## Scheduling

- One heavy operation globally: build, dependency installation, a matrix operation
  that can spawn producers, or active native QA. These operations do not overlap.
- At most two lightweight agent lanes; no new agents without replacing a finished
  lane. Source review is lightweight only if it does not compile or start producers.
- The root agent grants the heavy slot after checking actual process ownership and
  current capacity. A previous handle, receipt or expected completion is not a lease.
- Hold `/home/lyuaoss/projects/FsusBlog/.tmp/governance/resource-control-20261001.heavy.lock`
  with `flock -n --close LOCK COMMAND...` for the complete admitted operation.
  A refused lock is a scheduling wait, not a test failure or permission to bypass it.
- Before admission, require at least 6 GiB host MemAvailable and predict at least
  4 GiB remaining at peak. Check the actual cgroup limits, live resident resources,
  CPU pressure and the destination filesystem too. Retained QEMU RAM counts even
  when the guest is idle. Stop admitting new work if memory pressure rises.
- Put restored worktrees, build outputs and dependency scratch on the root disk,
  not `/dev/shm`. Keep external-disk writes small until its capacity is recovered.
  Preserve shared dependency caches, raw evidence, WIP and original resource profiles.
- Observe admitted processes periodically. Never count an OOM, interruption,
  disappearing handle, incomplete TRX or partial output as a pass. Do not kill
  unrelated processes, reusable servers or QEMU to release a slot.

## Current recovery epoch

Observed host boot ID: `b1856c1f-dc07-4512-ae5f-27ccbb657bb8`.
Boot start reported by `uptime -s`: `2026-10-01 17:19:07` Asia/Shanghai.
Old QEMU PID 2198147 is absent; old `/dev/shm` worktrees are absent.
Do not reuse pre-reboot process identities or cold-state attestations.

The durable 78523 build/pure report remains historical evidence for its exact head;
its tmpfs compiled artifacts are not available for new native execution.
The durable 43feca #3586 bundle is available for a disk-backed source recovery.
Incomplete pre-reboot tasks require evidence-led recovery, not automatic restart.

Current-boot task cgroup OOM counters were zero at inspection. Access to previous
kernel logs was unavailable; the prior reboot cause is not independently established.
These scheduling limits do not change production contracts, test budgets, selectors,
required matrix coverage, acceptance authority or trusted-policy promotion rules.

## Current batch preparation-only environment boundary (2026-10-04)

The later root-approved task-only Debian bootstrap/preparation phase is narrower
than full build, native QA or matrix admission. It retains the V8/V10 operational
geometry: one heavy lock for the complete VM lifetime, 2 CPUs, 2496 MiB guest RAM,
2 GiB host MemAvailable runtime floor plus 268 MiB startup headroom. Fresh startup
requires at least 5,045,747,712 bytes host MemAvailable and 2,537,889,792 bytes root
disk available; root runtime floor is 1,593,835,520 bytes, COW cap 768 MiB and each
VM log cap 16 MiB. The launcher actively refuses insufficient startup capacity and
terminates its owned process on runtime floor/cap breach; periodically inspect
actual process ownership, cgroup limits/events, pressures and guest capacity too.

This documents the existing root-approved preparation stage recorded in the
controlled-continuation checkpoint (original preparation-specific V8 and reviewed
V10), not a relaxation of repository tests or promotion of a source-only launcher.
The original preparation CLI still owns its capacity reservation, native execution
isolation, SDK readiness deadline and termination proof. A fresh configured user
bus may be initialized normally before a new original run, never by replacing an
original READY receipt. No failed checkpoint is resumed or recast as successful.

These figures permit only the bounded environment and original dependency
preparation phase, not full SDK builds, native backend QA, matrix or merge. The
general 6 GiB startup and predicted 4 GiB remaining policy above remains in force
for those wider heavy stages, as do original actual guest resource requirements.
Successful environment start or preparation alone is not acceptance.
