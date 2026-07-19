# Issue #1180 scheduler.yield local experiment

## Decision and scope

FsusBlog owns one locally typed scheduling adapter at
`src/frontend/src/performance/browserTaskScheduler.ts`. It detects
`scheduler.yield()` without adding that API to the ES2022 global library,
reports native/fallback/throttled outcomes, supports `AbortSignal`, records
visibility, falls back after native rejection, and rate-limits tight loops.

No production call site is enabled by this issue. A synthetic DOM projection
can establish that the adapter and measurement method work, but it cannot
attribute a long task in hydration, search, Markdown, admin projection, or
storage cleanup. Each future call site needs its own dataset, before/after
evidence, cancellation owner, budget, and rollback flag before importing the
adapter. Worker, cryptographic, credential cleanup, transaction, lock, and
protocol-frame boundaries remain excluded.

## Local controlled profiles

The committed runner defines condition-named profiles rather than device
claims:

| Profile | Viewport | Scale | Touch/mobile | CDP CPU rate |
| --- | --- | ---: | --- | ---: |
| `desktop-baseline-1x` | 1440×900 | 1 | no/no | 1 |
| `mobile-medium-4x` | 393×851 | 2.5 | yes/yes | 4 |
| `mobile-slow-6x` | 360×800 | 2 | yes/yes | 6 |

The runner launches the repository-pinned Playwright API against a regular
local Chrome/Chromium executable, starts one local Vite fixture server, holds
an exclusive `/tmp` lock, and uses one browser page at a time. There is no
public network dependency or added network latency.

Run at least five rounds per mode:

```bash
node tools/frontend/run-scheduler-yield-experiment.mjs \
  --rounds 5 \
  --output /tmp/fsusblog-issue-1180-scheduler-yield.json \
  --screenshot /tmp/fsusblog-issue-1180-scheduler-yield.png
```

The JSON binds the commit, browser, Playwright, Node, OS, CPU, logical
processors, memory, profiles, and local network condition. The runner writes a
shared host-epoch target into the page before the workload, dispatches a
trusted focused-key event at that target, and reports p50, p75, and p95 local
scripted dispatch-to-handler latency, total completion time, Long Task blocking,
CDP task/script duration, heap delta, Event Timing input/processing/presentation
distributions, Long Task attribution, and yield count. Each distribution keeps
all rounds without outlier removal and includes p50/p75/p95, mean, standard
deviation, minimum, and maximum. The result explicitly records that a stable per-operation GC count is
not exposed by CDP `Performance.getMetrics`; it does not substitute a heap
delta for GC evidence.

The dispatch metric includes local Node timer and CDP transport jitter; it is
useful only for relative control/candidate comparison under the same run. The
screenshot and JSON are local evidence and must stay outside the
repository. The fixture label, viewport, and CDP slowdown are not a real Pixel,
Android, iPhone, ARM CPU, field INP, or RUM claim.

## Gates and focused tests

```bash
cd src/frontend
vitest run --config vitest.config.ts \
  ../../tests/frontend/unit/performance/browserTaskScheduler.test.ts

cd ../..
node --test tests/tools/scheduler-yield-experiment.test.mjs
node tests/frontend/checks/static/check-browser-task-scheduler.mjs
```

The static gate rejects direct production `scheduler.yield()` calls and any
production import of the adapter. Firefox/WebKit correctness remains the timer
fallback contract covered through injected unit tests; Chromium alone owns the
CDP throttling experiment.

## Interpretation and rollback

`promising-local-fixture` means only that, under the fixed local fixture,
candidate p75 input delay and blocking improved while p75 total duration stayed
within the recorded tradeoff. Any other result is `do-not-enable`. Neither
classification enables a production call site.

Because no production path imports the adapter, rollback is immediate: stop
running the optional experiment or delete its local `/tmp` outputs. A future
call-site rollback must disable that call site's own flag without changing the
global ES2022 baseline or replacing Worker-owned computation with timer slices.
