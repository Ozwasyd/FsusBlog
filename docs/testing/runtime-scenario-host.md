# Runtime Scenario Host

Production Fresh retains the existing browserless runtime scenarios, identities, fault phases, and assertions for `integration`, `security`, and `resilience`. One source/run-bound Node host runs the repeated HTTP/AEDS/Auth CLIs and shares the Node module cache, global `fetch` keep-alive client, AEDS contract, URL/config, fixture helper, and metrics writer. Playwright and browser diagnostics stay outside the host; the [testing strategy](../testing.md) owns matrix policy.

## Canonical catalog

`config/testing/runtime-scenario-catalog.json` is the runtime-scenario authority. Its 25 entries are integration (9), security (9), and resilience (7); resilience explicitly retains the post-mutation notification contract, notification-live, binary-smoke, and second binary-contract checks. The pre-migration list had 23 scenarios: none was removed; the current catalog adds a real post-resilience notification-live recheck and reset-pollution negative fixture.

Every entry independently declares `id`, `phase`, `identity`, `fixture`, `requiredPreconditions`, `resetBarrier`, `expectedAssertions`, `coverageIds`, and `evidencePath`. `resident` entries also declare an importable module/export; `retained-cli` entries preserve one-shot/non-Node boundaries such as SW search, AOT cache, local exposure, and ZAP. The baseline locks scenario count and negative capabilities; speedups may not delete scenarios, merge identities, or treat log grep as a result.

## Execution and evidence

The three runtime lanes call:

```bash
node tools/test/run-runtime-scenario-host.mjs --phase integration
node tools/test/run-runtime-scenario-host.mjs --phase security
node tools/test/run-runtime-scenario-host.mjs --phase resilience
```

Evidence defaults to `.tmp/runtime-scenario-host/<run-id>/<phase>/`. Each resident scenario writes an independent result with source commit, worktree fingerprint, run ID, identity, fixture, assertion set, coverage IDs, status, failure diagnostics, and timing. `summary.json` is written only when the whole group succeeds; failure/cancel writes only `partial.json`, and later success cannot overwrite an earlier failure.

At identity/fault boundaries the host consumes only the `security-state` producer's exact owned-cleanup observation, bound by `FSUSBLOG_SECURITY_FIXTURE_CLEANUP_RECEIPT_FILE`; it never operates PostgreSQL or Redis directly. An unrecomputable receipt digest, remaining owned state, modified non-owned state, unpreserved other namespace, or active identity fails the scenario closed. `tests/tools/fixtures/runtime-scenario-host/polluted-identity.json` and `tests/tools/runtime-scenario-host.test.mjs` prove later success cannot cover pollution.

`SIGINT`/`SIGTERM` is explicit cancellation: stop new admission, mark unexecuted scenarios `cancelled`, retain partial evidence, and exit nonzero. Correctness is never blocked/failed by minutes, wall time, or scenario duration.

## Performance metrics and three-round acceptance

`performance` records `wallTimeMs`, `cpuSeconds`, `nodeProcessCount`, and `connectionSetupCount` counted from Node `undici:client:connected` events. These same-machine before/after observations always declare `affectsCorrectness=false`. Final acceptance compares the runtime bundle across three Production Fresh rounds at the same source SHA and machine; any assertion, reset, identity, or host failure remains a correctness failure regardless of speed. Focused tests are not final three-round evidence.

Collect six successful summaries with `tools/test/runtime-scenario-benchmark.mjs`:

```bash
node tools/test/runtime-scenario-benchmark.mjs \
  --before <before-1.json> --before <before-2.json> --before <before-3.json> \
  --after <after-1.json> --after <after-2.json> --after <after-3.json> \
  --output .tmp/runtime-scenario-host/before-after.json
```

The comparator rejects fewer than three rounds, non-success results, wrong source/run, and cross-machine inputs. It reports performance increase/decrease, never converting that direction into a correctness conclusion.

For same-SHA before rounds, use the retained per-CLI path with process
observation enabled:

```bash
FSUSBLOG_RUNTIME_SCENARIO_HOST=0 \
FSUSBLOG_RUNTIME_SCENARIO_COMPARE_VARIANT=before \
./tools/test.sh integration
```

`runtime-scenario-process-observer.mjs`, injected into each real Node CLI/npm process through `NODE_OPTIONS=--import`, records process CPU seconds and actual `undici:client:connected` counts; the lane then writes `<phase>/before-summary.json`. Without `FSUSBLOG_RUNTIME_SCENARIO_COMPARE_VARIANT`, the fallback path does not inject the observer. After rounds use the default host summary. Observer and comparator write diagnostics only and add no wall-time correctness gate.

## Risk and immediate rollback

Converting CLIs to a module runner could accidentally reuse top-level config or identity in one Node process. The host derives a separate username, admin username, and device fingerprint for every security scenario, rejects active identity before its reset barrier, and lets the catalog lock phase/fixture.

Rollback needs no backend/frontend restart:

```bash
FSUSBLOG_RUNTIME_SCENARIO_HOST=0 ./tools/test.sh integration
FSUSBLOG_RUNTIME_SCENARIO_HOST=0 ./tools/test.sh security
FSUSBLOG_RUNTIME_SCENARIO_HOST=0 ./tools/test.sh resilience
```

The switch makes the next lane use the retained per-CLI path; it does not modify service state, scenario assertions, or published artifacts. It is a diagnostic downgrade, never a conversion of host failure into success.
