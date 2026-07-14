# Production startup grants

Local production separates the resources required to start a physical bundle from the resources it should reach in
steady state. `startupMinCpuUnits` is a positive integer no greater than `minCpuUnits`; omitted startup fields retain
the legacy behavior by falling back to steady CPU and memory declarations. The production profile retains
`minimumSupportedCpuUnits: 4`, which covers the complete time-zero startup floor before any command is launched.

## Admission and expansion

Ready bundles are ordered by descending `startupPriority`, then descending critical-path `deadlineWeight`, then stable
bundle ID. The result is independent of matrix array order. The admission wave reserves every selected startup grant
before commands are spawned, so another ready bundle cannot consume the same CPU or memory. On exactly five CPUs the
time-zero layout is:

| Bundle | Startup CPU | Steady minimum CPU | Startup memory weight | Priority |
| --- | ---: | ---: | ---: | ---: |
| `build-static` | 1 | 2 | 3 | 3 |
| `backend-tests` | 1 | 2 | 4 | 4 |
| `frontend-tests` | 1 | 1 | 2 | 3 |
| `runtime-browser` | 1 | 1 | 5 | 4 |

Memory is divided from current free memory by startup weights; no fixed machine GiB value is encoded. A grant is never
admitted with zero memory. Once bundles are active, released CPU first brings grants toward their steady
`minCpuUnits`, then distributes remaining capacity by workload weight. Memory expansion follows live free memory and
steady memory weight. Admission of newly ready work happens before expansion, preventing a long-running elastic bundle
from starving a waiting bundle.

Four CPUs admit all four time-zero bundles at one CPU each. On five CPUs, startup priority assigns the remaining CPU
to `backend-tests`, producing `1/2/1/1` without a machine-specific branch. Machines with 4, 5, 6, 8, or 16 CPUs use
the same deterministic algorithm rather than per-machine constants.

## Evidence, failure, and rollback

Each physical tier checkpoint records `admittedAtMs`, `startupGrant`, `firstExecutableStepAtMs`, final
`resourceGrant`, and the ordered `resourceGrantHistory`. A ready dynamic tier that cannot receive its startup floor is
attributed to `waiting-for-startup-capacity`; dependency, exclusivity, and counted-resource waits remain distinct.
Failure, timeout, cancellation, and normal completion all release the active reservation through the same settle path.

Rollback requires only removing the production startup fields and minimum-supported floor. The scheduler then uses the
explicit compatibility fallback (`startupMinCpuUnits = minCpuUnits`, `startupMemoryWeight = memoryWeight`) without an
application restart, API change, test skip, or historical-result reuse.
