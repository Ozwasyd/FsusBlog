# Issue #1084: persistent UX browser pool

## Scope

`tools/ux/run-local-production-risk.mjs` keeps the governed boundaries risk plan, screenshots, progress receipts and summary checks unchanged, but Production no longer starts one Playwright CLI and one browser for every route-theme group. The default `pool` mode loads the TypeScript runtime once through Vite's public SSR API and launches Chromium through Playwright's public `chromium.launch()` API.

The explicit compatibility path is:

```bash
FSUSBLOG_UX_RISK_EXECUTION_MODE=cli node tools/ux/run-local-production-risk.mjs
```

This is a diagnostic fallback, not the Production default. The implementation does not import Playwright private runner, transport, connection or channel APIs, and remains pinned by the frontend lockfile to the repository Playwright version.

The CLI path uses the same lane-prefixed prepared session plan as the persistent pool; it never invents a `pw-0` fixture. Its stdout timing receipt is schema-validated, bound to the selected group and persisted as a unique `group-result.json`, so before/after measurements use the same per-group phase evidence instead of terminal text or inferred durations.

## Lifecycle and admission

Each pool slot owns one browser and one prepared lane-prefixed backend fixture session for its entire lifetime and consumes multiple groups sequentially. The runner and fixture preparer derive the exact same session IDs from `FSUSBLOG_TEST_SESSION_PREFIX`; the persistent runtime bootstrap is bound to the first resolved session fixture, and every worker leases one of those resolved IDs instead of assuming a literal `pw-N` name. Session IDs are leased from a bounded set sized to the host/configured maximum (at most the six governed risk groups) and returned only after the owning browser closes, so concurrently active workers never share a schema/Redis namespace and a later live-grant expansion never runs out of prepared isolation slots. Capacity is re-read from the run-bound scheduler grant before each admission decision. Growth starts additional slots; shrink never terminates an active group and causes excess workers to retire before taking another group. The UX step consumes one outer `chromiumLane` counted resource from the runtime-browser DAG, while the inner pool divides that step's live CPU and memory grant into local browser slots instead of giving every browser the full bundle grant.

The first runtime module load is the single writer for the fresh UX progress and pointer. Browser workers are created only after this initialization succeeds. Resume loads the existing matching run and dispatches only groups without successful receipts.

Cancellation closes every connected browser. A browser disconnect/closed-target failure is classified separately from a test assertion and may retry only the current group, up to `FSUSBLOG_UX_BROWSER_CRASH_RETRIES` (default `1`, maximum `3`). A successful progress receipt prevents re-execution after an ambiguous crash. Assertion failures are recorded and the remaining independent groups continue so one run can expose multiple errors.

## Isolation and logical equivalence

Every group calls `openThemedAuditedContext()` and therefore receives a fresh BrowserContext, cookie jar, local/session storage, IndexedDB, cache, permissions, service-worker scope, page and downloads scope. Risk mode disables service workers, and context teardown verifies that no page remains. Auth storage baselines are cached per browser through a `WeakMap`; a group's mutations cannot update the immutable baseline used to seed a later fresh context.

An isolated session schema can encounter the documented Public AOT cold response on its first anonymous navigation even when the shared release namespace is already hydrated. The runner treats only the complete retry contract (`503`, `server-status`, `transient-failure`, `no-store`, `noindex` and a positive `Retry-After`) as retryable, sleeps for the server-provided interval, and retries inside the existing machine-derived runtime deadline. It does not turn unrelated `5xx` responses into passes or extend a timeout with a lane-specific constant.

Each group has a unique `worker/group/attempt` output directory and a `group-result.json` error/timing context. Existing custom screenshots remain under the run-bound screenshot root. The persistent receipt preserves the Playwright logical suite/group ID and every case ID, while `uxViewportProgress` remains the exact-once authority for planned group, navigation and case counts.

## Evidence

`.tmp/release-evidence/local-production-ux-risk.json` uses `fsusblog.local-production.ux-risk.v2` and records:

- execution mode and fresh/resume source;
- Playwright process count, browser launch count, maximum live workers and crash retry count;
- time to first group, total UX wall-clock, worker launch/lifetime summaries and every group attempt;
- per-group timing results, logical test IDs and artifacts;
- process-tree peak RSS/process count sampled across the runner and Chromium descendants on Linux;
- the outer counted Chromium resource and inner live-grant capacity source;
- the unchanged UX model/risk counts and final run-bound summary.

Issue closure still requires three same-SHA, same-machine before/after fresh runs. Those measurements must report process count, launch count, time to first group, group startup phases, peak RSS, crash/resource errors and total UX wall time. They may not reduce groups, themes, navigations, screenshots or isolation.
