# Browser Readiness Contract

This is the canonical readiness oracle for real-browser correctness. The release execution and evidence boundaries are linked from the [Release Browser Contract](browser-contract.md) and [#1151 evidence governance](issue-1151-evidence-governance.md).

Browser correctness waits for a product state that a user or runtime can observe. networkidle is not such a state: Service Workers, notification streams, preloads, and background requests can keep or lose network activity without changing whether the feature is ready.

The canonical owner is tests/frontend/support/playwright/readiness.mjs. Callers select the narrowest helper matching the assertion:

| Product state | Canonical helper | Observable condition |
| --- | --- | --- |
| Public hydration | waitForPublicHydration | data-public-hydrated="true" |
| SPA route | waitForSpaRoute | Expected pathname and optional visible route content |
| Service Worker/cache | waitForServiceWorkerCacheReady | Active controller, ready registration, and governed cache names |
| Notification suppression | waitForNotificationSuppressed | Document suppression marker |
| Auth/permission | waitForAuthPermissionReady | Authorized pathname and visible permission-gated content |
| General runtime | waitForApplicationReady | Visible app, hidden loader, and startup/hydration evidence |
| Screenshot frame | waitForVisualFrameReady | Loaded fonts and two post-style animation frames |

Every timeout names the unmet condition. Callers must not catch a readiness timeout and continue.

Correctness assets cannot call page.waitForTimeout directly. A performance, soak, or animation measurement may use runBrowserMeasurementWindow only when it supplies a human-readable purpose, a finite maxWindowMs no greater than 60 seconds, and an approved evidenceClass. Such a window measures elapsed time; it never establishes correctness readiness.

config/testing/browser-readiness-migrations.json records the migrated source groups, their old wait condition, and the replacement oracle.
