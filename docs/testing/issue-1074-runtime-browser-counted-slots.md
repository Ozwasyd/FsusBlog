# Runtime browser counted slots

Production `runtime-browser` uses a counted `chromiumLane` resource instead of encoding minimum-machine browser
protection as a permanent dependency chain. CPU, memory, `maxParallel`, named exclusivity, real DAG dependencies, and
the counted slot must all admit a step before it starts. Completion, failure, timeout, and cancellation release exactly
the admitted slot; a live grant contraction never kills a running lane but prevents further admission.

## Machine-derived capacity

The bundle re-resolves slot capacity whenever it reads its live scheduler grant. The resolver combines current CPU and
memory, browser-lane P95 RSS, memory headroom, file-descriptor and process limits, and
`FSUSBLOG_CHROMIUM_LANE_MAX_SLOTS`. When same-machine prior resource evidence is available it supplies P95 RSS and
browser process fanout; otherwise the fallback derives both from current machine CPU and memory. The default explicit
ceiling also scales from machine CPU. A constrained input always resolves to one slot, retaining the prior safe serial
behavior.

CPU and memory are divided between the admitted lanes before their commands start. Each lane therefore receives only
its own `FSUSBLOG_STEP_CPU_BUDGET`, `FSUSBLOG_STEP_MEMORY_GIB`, and derived Playwright worker budget; it cannot read the
whole bundle grant. Slot growth starts another fixed-size lane and does not resize a running Playwright suite.

## Dependency and isolation boundaries

`runtime-integration` remains the article/cache mutation boundary. `release-public` still waits for it and stable
release hydration. Browser readers start only after their real runtime prerequisites, while independent UX,
cross-browser, render-pressure, and resilience work can overlap when more than one slot is available.

ZAP remains behind every Chromium-bearing lane because its container lifecycle changes host networking. Benchmark and
quiet windows remain in `performance-evidence` behind their named isolation resource. Coordination-only joins consume
no counted slot.

Every concurrent browser lane receives a run-and-step-bound namespace, session identity, output root, and three unique
loopback proxy ports for the debug backend, debug frontend, and release preview. The proxy preserves the authoritative
runtime and readiness marker while removing shared `PLAYWRIGHT_BASE_URL`/port identity between sibling lanes. Existing
lane-specific Playwright output, screenshot, trace, and evidence paths remain disjoint. The bundle owns each proxy and
the complete detached child process group, so failure, timeout, or cancellation closes lane ports and descendants
without stopping siblings.

## Evidence and rollback

The runtime bundle summary contains `browserAdmission` with initial/peak/final slots, plan and grant history,
active/peak lanes, per-lane grants, ports, RSS and sampled browser-process counts, slot wait intervals, lane overlap,
resource error counts, and the resource-utilization evidence path. `ERR_INSUFFICIENT_RESOURCES`, OOM, browser crash,
and FD pressure are reported separately.

Rollback is limited to the counted-resource declarations, resolver, and lane proxies. Restoring the former dependency
chain preserves all test IDs and stable artifacts; no application API or runtime production behavior changes.
