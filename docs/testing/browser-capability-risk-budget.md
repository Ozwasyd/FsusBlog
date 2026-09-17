# Browser Capability-Risk Budget

Cross-browser diagnostics use the versioned risk closure in the [browser capability-risk catalog](../../tests/browser-capability-risk/catalog.json). Selection never removes an engine because of recent failures, host load, or remote-browser results. The selector reads only changed paths, the catalog, Playwright projects, and matrix metadata, then emits fsusblog.browser-capability-risk-proof; identical input produces identical engines, scenarios, risk IDs, and exclusion reasons. The [#1148 diagnostics handoff](issue-1148-browser-diagnostics.md) owns diagnostic execution; the [Release Browser Contract](browser-contract.md) owns release correctness.

The three profiles have non-substitutable duties:
- browser-primary-correctness runs canonical public-route correctness only in Chromium; generic UI, state, and business changes are not repeated in Firefox/WebKit.
- browser-capability-delta runs a Chromium comparison plus Firefox/WebKit capability probes for engine differences and fallbacks in Service Worker, Cache Storage, worker runtime, hydration/dynamic import, passkey, and conditional mediation.
- browser-full-matrix runs every declared scenario on its required engines and produces nightly, release-reliability, release-final, and explicit local-full runs. Its single local entry point is FSUSBLOG_BROWSER_PROFILE=browser-full-matrix ./tools/test.sh ci-tier cross-browser-smoke --no-deps.

The default profile is also full. Firefox/WebKit omit only generic product navigation proved by browser-test:primary-public-route-navigation, not capability behavior; they still run browser-test:capability-engine-delta, and every risk references Chromium canonical evidence. Adding a risk, scenario, engine, test ID, or Playwright project without synchronizing the catalog and matrix fails static governance closed.

Generate a changed-path proof with node tools/testing/browser-capability-risk.mjs select --path src/frontend/src/workers/wasmDecode.worker.ts. Changes to the catalog, selector, matrix, or Playwright config force browser-full-matrix. Ordinary business paths select primary; worker or Service Worker paths select every engine required by their risks. Every proof lists unselected scenarios and reasons, and “no recent failures” is never a valid exclusion reason.
