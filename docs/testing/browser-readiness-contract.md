# Browser readiness contract

Browser correctness tests wait for a product state that a user or runtime can
observe. `networkidle` is not a product state: service workers, notification
streams, preloads and background requests can all keep or lose network activity
without changing whether the tested feature is ready.

The canonical owner is
`tests/frontend/support/playwright/readiness.mjs`. Callers select the narrowest
helper that describes the assertion:

| Product state | Canonical helper | Observable condition |
| --- | --- | --- |
| Public hydration | `waitForPublicHydration` | `data-public-hydrated="true"` |
| SPA route | `waitForSpaRoute` | expected pathname and optional visible route content |
| Service worker/cache | `waitForServiceWorkerCacheReady` | active controller, ready registration and governed cache names |
| Notification suppression | `waitForNotificationSuppressed` | document suppression marker |
| Auth/permission | `waitForAuthPermissionReady` | authorized pathname and visible permission-gated content |
| General runtime | `waitForApplicationReady` | visible app, hidden loader and startup/hydration evidence |
| Screenshot frame | `waitForVisualFrameReady` | fonts loaded and two post-style animation frames |

Every timeout names the unmet condition. Callers must not catch readiness
timeouts and continue.

Correctness assets cannot call `page.waitForTimeout` directly. A performance,
soak or animation measurement may use `runBrowserMeasurementWindow` only when
it supplies a human-readable `purpose`, a finite `maxWindowMs` no greater than
60 seconds and an approved `evidenceClass`. Such a window measures elapsed time;
it never establishes correctness readiness.

`config/testing/browser-readiness-migrations.json` records the migrated source
groups, their old wait condition and the replacement oracle.
