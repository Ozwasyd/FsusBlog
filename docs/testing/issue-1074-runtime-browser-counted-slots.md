# Runtime browser counted slots (retired from correctness)

Issue #1074 introduced a machine-adaptive counted `chromiumLane` inside the production `runtime-browser` bundle.
Issue #1148 retires that mechanism from the default local production and correctness path. This document now records
the historical boundary and the replacement diagnostics contract; it no longer describes active correctness
scheduling.

## Default correctness boundary

`runtimeSteps()` does not declare `chromiumLane` or any browser-specific counted resource. Security runtime,
authenticated DAST, release-public, and thin acceptance steps are admitted only by their real DAG dependencies and
the CPU/memory grant already owned by the physical bundle.

`run-bundle.mjs` therefore does not:

- derive browser slot counts from free memory, CPU, historical RSS, file-descriptor limits, process limits, or load;
- parse `FSUSBLOG_CHROMIUM_LANE_MAX_SLOTS`;
- wrap correctness steps with lane proxies, lane-specific fixture/session roots, or extra Playwright output roots; or
- emit `browserAdmission` / `fsusblog.runtime-browser-admission.v1` evidence.

The generic counted-resource DAG implementation remains available for non-browser resources and explicit outer
orchestration. It is not a hidden browser scheduler for the production correctness bundle.

## Browser diagnostics owns the single slot

Nightly/manual browser diagnostics is the only owner of the Chromium admission boundary. The workflow and lane invoke
the diagnostics runner with an explicit worker limit of `1`; the runner rejects every other value. Its receipt records
`outerAdmissionMode: single-explicit-browser-diagnostics-tier`, `maxActiveBrowserLanes: 1`,
`dynamicInnerPool: false`, and serial category execution.

That fixed outer slot is passed unchanged to Playwright and category-specific worker environment variables. The inner
runner must not inspect free memory, CPU load, or historical resource evidence, and it must not grow an additional
worker pool. Firefox and WebKit probes run within the same serial diagnostics boundary rather than acquiring parallel
correctness lanes.

## Evidence and recovery

Correctness bundle summaries retain ordinary resource-utilization evidence but contain no browser-admission plan or
lane proxy evidence. Browser diagnostics writes separate plan, per-category summaries, logs, artifacts, and a final
diagnostic receipt. Diagnostic failures do not redefine correctness evidence.

If browser pressure or instability appears, rerun or narrow the nightly/manual diagnostics categories while preserving
the fixed outer single-slot limit. Recovery does not require changing application runtime behavior or reintroducing the
#1074 machine-adaptive admission path into production correctness.
