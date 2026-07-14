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

`memory.high` equals the scheduler memory grant. `memory.max` adds machine-derived safety headroom while remaining
inside physical memory; `pids.max` is derived from both granted CPU and memory. Expansion or contraction rewrites all
effective controls without restarting the bundle. The scheduler evidence compares every declared grant with the
values read back from `cpu.max`, `cpu.weight`, `memory.high`, `memory.max`, and `pids.max`.

## Process and container attribution

In enforced mode the bundle entry shell starts stopped, the scheduler moves it into the bundle cgroup, and only then
resumes it. Ordinary descendants therefore inherit the boundary without a spawn race. Application-level worker
planning remains authoritative inside the boundary (`FSUSBLOG_STEP_CPU_BUDGET`, Playwright workers, .NET processors,
MSBuild `/m`, and similar settings).

Production container helpers translate the admitted step grant to `--cpus`, `--memory-reservation`, `--memory`, and
`--pids-limit`. Containers are labeled with run, bundle, and step identity. Existing acceptance PostgreSQL/Redis
containers are updated before restart. Bundle evidence reads Docker's effective `HostConfig` back and compares it to
the labeled step limits; unavailable Docker or a missing binding is never reported as zero or success. Rootless Docker
is supported only when its daemon accepts the same flags, otherwise the real Docker error remains visible.

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
