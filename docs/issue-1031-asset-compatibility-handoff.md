# Issue #1031 old frontend and retained asset compatibility handoff

This handoff covers item 5 of issue #1031. The probe is now wired into the central
rollout state machine while retaining the existing append-only release storage and
retention-window GC policy. The implementation remains unverified until the unified
validation phase.

## Delivered paths

- `tools/deployment/release-asset-compatibility-probe.mjs`
- `tools/deployment/release-asset-browser-session.mjs`
- `tools/deployment/release-asset-compatibility-evidence-verify.mjs`
- `tests/tools/release-asset-compatibility-probe.test.mjs`
- `tests/frontend/e2e/acceptance/release-asset-compatibility.spec.ts`
- `tests/fixtures/deployment/release-asset-browser-scenario.template.json`
- `docs/issue-1031-asset-compatibility-handoff.md`

`release-rollout.sh` now starts the probe as a separate process, passes the controlled
browser binding key, persists its PID for `--resume`, writes drill-bound switch and
GC signals, runs applied release-asset GC, waits for the final browser evidence, and
verifies that evidence with the same key and rollout identity. The probe still never
switches traffic or mutates rollout state itself.

## Drill contract

The probe uses one process and three lifecycle points:

1. Before switching, it loads the N-1 release-scoped `index.html` and
   `asset-manifest.json`, then fetches every immutable JavaScript, CSS, Wasm and font
   entry. It verifies each body against the manifest SHA-256 and writes a checkpoint.
2. It writes a drill-bound `ready` document, then waits for a matching `switched`
   signal. Stale signals or signals from another drill are ignored.
3. After the switch, it requests every N-1 release URL through the public gateway,
   checks each status and SHA-256, checks the retained N-1 Service Worker and its
   cache set, and runs old-frontend-to-new-backend plus
   new-frontend-to-old-backend requests against the direct slot origins.
4. It waits for a matching `gc-complete` signal. It requires applied
   `fsusblog.release-assets.gc-evidence.v1` evidence, requires the N-1 release to be
   protected by `retention-window`, verifies that the drill is still inside the
   declared retention window, and requests every old resource again.
5. It emits `fsusblog.release-asset-compatibility-evidence.v1`. Failures are
   accumulated without an error-count cap.

The release evidence fields already consumed by
`release-rollout-evidence.mjs` are present:

- `status` is `pass` only when all stages pass;
- `notFoundCount` counts every post-switch and post-GC old-resource 404;
- `hashMismatchCount` counts every response whose body differs from the N-1
  manifest;
- `scenarios.oldFrontendToNewBackend`;
- `scenarios.newFrontendToOldBackend`;
- `scenarios.oldServiceWorkerCache`.

Additional evidence records delayed asset coverage, the retention-window result,
all request observations, response release IDs, lifecycle timestamps, GC semantics
and the complete uncapped error list.

## Scenario file

The caller supplies a JSON scenario. The direct old backend must remain available
until the compatibility stage finishes; the public base URL must point at the
gateway that is switched by the rollout.

```json
{
  "schema": "fsusblog.release-asset-compatibility-scenario.v1",
  "drillId": "rollout-20260711-asset-compatibility",
  "oldReleaseId": "release-20260710-aaaaaa",
  "newReleaseId": "release-20260711-bbbbbb",
  "oldFrontendBaseUrl": "http://127.0.0.1:5080",
  "publicBaseUrl": "https://blog.example.test",
  "oldBackendBaseUrl": "http://127.0.0.1:5080",
  "newBackendBaseUrl": "http://127.0.0.1:5081",
  "compatibilityRequests": {
    "oldFrontendToNewBackend": [
      {
        "id": "old-home-frame-from-new-backend",
        "method": "GET",
        "path": "/api/binary/article/list/home/1/10.aeds",
        "expectedStatuses": [200],
        "expectedHeaders": {
          "content-type": "application/octet-stream"
        }
      }
    ],
    "newFrontendToOldBackend": [
      {
        "id": "new-home-frame-from-rollback-backend",
        "method": "GET",
        "path": "/api/binary/article/list/home/1/10.aeds",
        "expectedStatuses": [200],
        "expectedHeaders": {
          "content-type": "application/octet-stream"
        }
      }
    ]
  },
  "retention": {
    "untilUtc": "2026-07-18T04:00:00.000Z",
    "requiredProtectionReason": "retention-window"
  },
  "requestTimeoutMs": 10000
}
```

Defaults are intentionally strict:

- the old index is
  `/release-assets/<oldReleaseId>/index.html`;
- the manifest is
  `/release-assets/<oldReleaseId>/asset-manifest.json`;
- the old Service Worker is
  `/release-assets/<oldReleaseId>/sw.js?build=<oldReleaseId>`;
- JavaScript, CSS, Wasm and font coverage are all required;
- backend compatibility responses must expose the expected
  `X-Fsus-Release-Id`;
- GC must be applied, not a dry run.

`oldIndexPath`, `oldManifestPath`, `requiredAssetKinds`,
`serviceWorker.scriptPath` and `serviceWorker.cachePaths` can be explicit when a
release fixture needs a different immutable layout. Compatibility requests can
also declare body, request headers, accepted statuses, response headers and an
expected response SHA-256.

## Process entrypoint

The intended rollout invocation is:

```text
node tools/deployment/release-asset-compatibility-probe.mjs \
  --scenario <scenario.json> \
  --checkpoint <checkpoint.json> \
  --ready-file <ready.json> \
  --switch-file <switched.json> \
  --gc-file <gc-complete.json> \
  --gc-evidence <release-asset-gc-evidence.json> \
  --out <asset-compatibility.json>
```

`ready.json` contains the generated or supplied `drillId`. The rollout must write
the other two files atomically with this schema and the same `drillId`:

```json
{
  "schema": "fsusblog.release-asset-compatibility-signal.v1",
  "drillId": "rollout-20260711-asset-compatibility",
  "stage": "switched",
  "observedAtUtc": "2026-07-11T04:05:00.000Z"
}
```

The GC signal uses `"stage": "gc-complete"`. Merely touching a file does not
release the probe. This prevents a stale file from an interrupted rollout from
silently skipping the required phase boundary. The default signal timeout is 15
minutes; `--signal-timeout-ms` and `--signal-poll-ms` are bounded overrides.

The probe writes a failure evidence object and exits non-zero on invalid input,
capture failure, signal timeout, compatibility failure, GC evidence failure, 404,
hash mismatch or network error. It never switches traffic, runs GC, stops a slot or
mutates rollout state.

All non-loopback origins must use HTTPS. Plain HTTP is accepted for direct loopback
slot rehearsals; `FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE=1` is the explicit local-test
override and must not be set by the production entrypoint.

## Test coverage added

The Node contract suite specifies:

- quoted and unquoted index resource discovery;
- strict scenario normalization;
- pre-switch manifest/hash capture for JS, CSS, Wasm and font;
- drill-bound switch and GC signals;
- both frontend/backend compatibility directions;
- applied GC and `retention-window` protection;
- rollout-compatible evidence fields;
- aggregation of simultaneous 404, hash, backend identity and GC failures;
- fail-closed behavior before switch when a required asset kind is absent.

The Playwright acceptance drill creates an isolated loopback Blue/Green fixture. It
loads an N-1 index before switching, holds the initial JS and CSS requests in flight,
releases them only after the simulated gateway moves to N, and hashes JS, CSS, Wasm
and font bodies in the browser. It then:

- proves the old page talks to the new backend;
- registers an old release-scoped Service Worker and warms its CacheStorage;
- removes the network copy temporarily and proves the old Service Worker cache
  still serves the exact old bytes;
- applies simulated GC while retaining the old release and rechecks every old
  asset directly over the network;
- loads the N frontend after simulated rollback and proves it talks to the old
  backend;
- rejects any old release asset 404.

## Current rollout integration readback

The active wiring is now:

1. `--asset-compatibility-scenario` is required and must bind the exact
   source/target release IDs with `browser.required=true`.
2. `--asset-browser-binding-key-file` is a separate mode-0400/0600 regular
   non-symlink HMAC key; the resolved rehearsal plan field is
   `evidenceInputs.assetBrowserBindingKey` and the key must contain 32..4096 bytes.
3. The rollout starts or adopts the probe, writes `switched` only from its own
   lifecycle, applies GC, validates applied GC evidence, writes `gc-complete`, waits
   for the probe, and verifies the final HMAC binding before sealing
   `assetCompatibility`.
4. `--resume` may reuse an already completed artifact only after the verifier
   recomputes its scenario, rollout and HMAC binding; it may not trust file presence.

Unified validation must still prove that the browser `ready` checkpoint precedes
the real gateway switch under load, that both direct origins remain reachable until
compatibility completes, and that post-GC reads are served by the retained old
Service Worker/cache with zero 404/hash mismatch. A failed ordering check is an
implementation blocker, not a documentation exception.

## Verification status

Per the current parallel implementation instruction, no test, build, lint, syntax
check or other validation command was run for this handoff. The implementation and
test code are present but unverified until the later unified validation phase.
