# Production cgroup and OCI resource enforcement

Linux local production can map scheduler grants to cgroup v2 and Docker/OCI limits. The switch is
`FSUSBLOG_CGROUP_ENFORCEMENT=auto|strict|advisory|off`:

- `auto` attempts a delegated cgroup v2 root and otherwise records an explicit advisory reason;
- `strict` has the same capability probe but fails before bundles start if enforcement cannot be created;
- `advisory` retains application-level worker grants and evidence without mutating cgroups;
- `off` is an explicit rollback switch. It does not claim enforcement.

An alternate delegated root can be supplied with `FSUSBLOG_CGROUP_DELEGATE_ROOT`. It must be inside the cgroup v2
mount, writable, and expose `cpu`, `memory`, and `pids`. The production-only hierarchy is
`fsusblog-production/<run-id>/<physical-bundle>`. Ordinary tests and CI DAGs default to advisory and never create this
hierarchy. GitHub-hosted runners, rootless sessions, and non-Linux hosts therefore remain usable while their evidence
states the unsupported or permission-limited reason. Set `strict` only where systemd, the container runtime, or the
runner has delegated the controllers.

For a systemd user manager that permits delegation, an isolated strict invocation is:

```bash
systemd-run --user --scope -p Delegate=yes --quiet \
  env FSUSBLOG_CGROUP_ENFORCEMENT=strict ./tools/test.sh production --fresh
```

The runner moves itself into a private manager leaf before enabling controllers, but only when it is the sole process
in the delegated scope. A shared terminal/tmux cgroup is never rearranged; it degrades with `EBUSY` instead.

## CPU and memory policy

Every bundle receives both `cpu.weight` and `cpu.max`. Weight preserves the scheduler's relative share under
contention. `cpu.max` is a hard ceiling equal to the current dynamic CPU grant, so an uncooperative Chromium, MSBuild,
Vite, testhost, or native descendant cannot consume a sibling's allocation. This quota is an isolation boundary, not
a performance technique. A benchmark receives a stable full grant only after the scheduler's exclusive
`benchmark-window` and dependency rules release sibling resources; throttling is never counted as an optimization.

`cpuset.cpus` is deliberately disabled: topology, NUMA placement, heterogeneous cores, and dynamic redistribution are
not yet proven. A wrong cpuset can make throughput and benchmark variance worse even when CPU counts appear correct.

`memory.high` projects the scheduler memory grant down to an exact kernel page boundary. `memory.max` adds
machine-derived safety headroom, also rounded down to a page boundary while remaining inside physical memory;
`pids.max` is derived from both granted CPU and memory. Linux page size is observed through `getconf PAGESIZE` and
recorded with the projected controls; missing page-size evidence fails closed. Page rounding does not widen a grant
or permit a read-back tolerance. Expansion or contraction rewrites all
effective controls without restarting the bundle. The scheduler evidence compares every declared grant with the
values read back from `cpu.max`, `cpu.weight`, `memory.high`, `memory.max`, and `pids.max`.
Any CPU or memory grant above the admitted machine envelope fails before control files are written, so enforcement
cannot silently clamp an oversold grant or emit an invalid `memory.high > memory.max` pair.

## Process and container attribution

In enforced mode the bundle entry shell starts stopped, the scheduler moves it into the bundle cgroup, and only then
resumes it. Ordinary descendants therefore inherit the boundary without a spawn race. Application-level worker
planning remains authoritative inside the boundary (`FSUSBLOG_STEP_CPU_BUDGET`, Playwright workers, .NET processors,
MSBuild `/m`, and similar settings).

The Linux physical-execution adapter now accepts an explicit task-owned slice ancestor for nested systemd work. When
one is supplied, it first checks the caller's unified cgroup membership, starts the transient unit with
`--slice-inherit`, and checks the unit's actual slice, cgroup path and supervisor identity again before releasing the
target process. A missing, foreign or drifting ancestor fails closed. This guard does not establish the ancestor or
partition the scheduler grant: #3527 must still connect the durable bundle and resource owner to one real task slice
before nested execution can count as production resource enforcement.

Production container helpers translate the admitted step grant to `--cpus`, `--memory-reservation`, `--memory`, and
`--pids-limit`. Containers are labeled with run, bundle, and step identity. Existing acceptance PostgreSQL/Redis
containers are updated before restart. Bundle evidence reads Docker's effective `HostConfig` back and compares it to
the labeled step limits; unavailable Docker or a missing binding is never reported as zero or success. Rootless Docker
is supported only when its daemon accepts the same flags, otherwise the real Docker error remains visible.
Once any OCI limit is present, the entire CPU/memory/pids tuple and all three identity fields are mandatory; partial,
zero, inverted memory, or anonymous configurations fail closed instead of starting an unconstrained container.

### Scoped container reservations

`createProductionResourceEnforcer().reserveContainerResources` partitions an already admitted bundle grant; it is not
a second scheduler or an additional grant. Its closed request binds the current run, repository, namespace, exact
producer/source and positive CPU/memory-high/memory-max/PID tuple. The reservation is available only from a live
enforced owner, never advisory/off mode. Reservation IDs are single-use within that owner.

The bundle's total grant remains the scheduler accounting unit. Reserved container CPU, both memory limits and PIDs
are subtracted before applying the process cgroup controls. CPU quota is rounded down within the residual share;
memory safety headroom is partitioned once, not re-created for each participant. Container memory reservations must
themselves be page-aligned; they are never silently rounded away from the lifecycle's declared identity. A reservation or dynamic contraction
that leaves no valid process share fails before writing controls. Subsequent dynamic updates retain the same container
allocation and recompute only the process share. The scheduler publishes worker grants only after control read-back
succeeds; when reservations exist, its grant document separates the worker share, total grant and container bindings.

The returned capability's `assertHeld` checks exact caller identity/limits, live membership of the attached bundle
process, and all effective process controls. It does not treat OCI labels as a resource lease. `releaseAfterCleanup`
retains the allocation while awaiting the canonical lifecycle's cleanup, and reclaims it only after that owner
confirms both container absence and credential removal. Rejected, incomplete or concurrent cleanup does not release
the grant. Enforcer cleanup reports `retained-container-reservations` while any allocation remains, even if its process
cgroup is empty. Evidence records total/process/reserved shares and each allocation alongside effective controls.

This API does not start, adopt or delete containers, establish fixture admission, or discover grants from environment
variables. Its caller must be the enclosing canonical supervisor, which owns durable recovery binding and invokes the
exact lifecycle cleanup before releasing scheduler usage. The MySQL supervisor/bootstrap/fixture wiring is not yet
implemented; direct component use of this resource owner is not full scheduler or fixture qualification. Existing
PostgreSQL/Redis and resident-runtime handoff semantics are unchanged.

## Evidence and cleanup

The #1071 canonical resource report embeds `resourceEnforcement` from the final checkpoint. Per bundle it includes:

- cgroup path and grant history;
- effective controls and consistency status;
- `cpu.stat` throttling counters;
- CPU and memory PSI;
- `memory.current`, `memory.events` including high/max/OOM/OOM-kill;
- `pids.current`, `pids.events`, and Docker effective limits.

Normal completion, failure, SIGINT, and SIGTERM terminate bundle process groups, sample final counters, and remove empty
owned cgroups. Cleanup retains a cgroup containing live processes and reports `retained-active`, so an active run is
never deleted. The next enforced run removes only empty stale run groups left by a crash; a SIGKILL cannot run cleanup
code, so this stale-empty recovery is the crash path. Existing runtime cleanup remains responsible for labeled service
containers.

The complete rollback is `FSUSBLOG_CGROUP_ENFORCEMENT=off`; it leaves ordinary development test behavior unchanged.
