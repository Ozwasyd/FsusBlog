# Release Browser Contract

This page is the canonical release browser-contract execution boundary. Maintainers use it for the runner and invariant owners; release and operations reviewers use it for identity, evidence, and failure gates; contributors use it for supported scenarios, the command, and fallback boundaries. Evidence classification and retention are canonical in the [#1151 evidence governance](issue-1151-evidence-governance.md); the dedicated fixture lifecycle is canonical in the [#1149 Browser Contract fixture](issue-1149-browser-contract-fixture.md).

tests/browser-contract/run.mjs is the only real-browser correctness probe for release-final. It uses the lockfile's managed Chromium through Playwright Library, without the Playwright Test worker pool, shards, or suite retry.

Its evidence class is fixed as browser-contract, not generic correctness or diagnostic. Production Summary does not consume this receipt. Release Final fails closed when the receipt is missing, unsuccessful, or not consistently bound to the source, build, and digests.

## Fixed topology

- One Chromium launch and at most one concurrent browser root.
- Five baseline scenarios run sequentially. A sixth WebAuthn-success scenario is added only when the immutable fixture explicitly declares the step-up registration prerequisite. Each scenario creates and closes a new BrowserContext.
- Zero worker pool, zero shard, and zero retry.
- The lane defaults to a nine-minute timeout; it sends TERM first and terminates the complete process group 15 seconds later.
- A crash or disconnect is classified directly as infra; it is not rerun or promoted to a clean pass.

## Scenario catalog and deterministic selection

| ID | Browser-only risk |
| --- | --- |
| public-hydration-history-reload | Direct AOT article entry, real Vue hydration, first-interaction takeover, public navigation, back, reload, and head/body plus app/shell identity |
| account-deep-link-bootstrap | Open a protected deep link with a real ordinary-account cookie and complete account bootstrap |
| admin-deep-link-expired-session | Complete permission bootstrap with a real admin cookie; after expiry, preserve the redirect target and render the login page |
| article-publish-persistence | The admin UI sends a real prepublish/create request; after success, reload still retrieves the article; only one write is performed |
| webauthn-virtual-authenticator | Conditional scenario: when the fixture receipt declares webAuthnRegistration=true, Chromium CDP's virtual authenticator completes a real registration ceremony and the credential remains after reload |
| service-worker-offline-reload | After Service Worker takeover, offline reload follows the private/no-store 503 policy and can reload after network recovery |

Selection reads only this run's immutable fixture capability declaration. It does not read host load, live grants, prior evidence, or browser probe results, so identical input yields identical scenario IDs. The current baseline fixture has no consumable step-up proof and therefore selects the other five scenarios; the #1149 producer may declare that capability only after creating an account session that can complete registration. Ordinary Router, component-state, API-payload, permission, cache, and persistence correctness belongs to browserless tests and is not duplicated here as a route/viewport/theme matrix.

## Inputs and outputs

Before reading an old receipt or launching Chromium, the runner fail-closed verifies that explicit FSUSBLOG_TEST_SOURCE_COMMIT and FSUSBLOG_TEST_SOURCE_FINGERPRINT exactly match the #1078 immutable production build receipt. That receipt must contain backend-runtime, frontend-dist, wasm, and generated-contracts; GITHUB_SHA cannot substitute for the dedicated source identities. config/testing/playwright-browser-identity-policy.json then resolves the lockfile-managed Chromium. A host executable override, missing managed binary, non-canonical path, revision/catalog mismatch, or binary-digest drift fails before fixture or browser launch.

The #1149 fixture producer fixes `1 session / 1 concurrency`: a run-dedicated PostgreSQL instance/schema, Redis instance/namespace, ordinary user, admin, and sealed auth/storage manifest. It does not read live CPU/memory grants or PostgreSQL PID headroom, clone a schema per worker, or fall back to shared `public`. Scenarios consume only the stable fixture view produced by `createPublishedArticle()`, `createPendingComment()`, `createUserSession()`, `createAdminSession()`, and `resetContractNamespace()`; browser scenarios run no SQL, Redis, or Docker commands. See the [#1149 fixture lifecycle](issue-1149-browser-contract-fixture.md).

The fixed uploadable outputs are .tmp/browser-contract/receipt.json and .tmp/release-evidence/public-preview-screenshots.json. Before cleanup, the sealed fixture manifest is .tmp/browser-contract/fixtures/<namespace>/contract-fixture.json; local private debugging artifacts are under .tmp/browser-contract/runs/<namespace>/.

The receipt records source/build fingerprint, run/lane/preparation identity, database/Redis identity, stable entity IDs, per-step cleanup evidence, and planned/actual browser identity: browser name/version/revision, canonical executable path and SHA-256, Playwright package/catalog digest, exact launch arguments, font/locale digest, locale, device scale, headless rendering, color scheme, and software-GPU mode. It also records exact scenario IDs, launch/context counts, wall clock, console/page/request issues, product/contract/infra classification, and relative paths to local evidence; raw traces, screenshots, and session material are not inlined.

The scenario context count covers only the five or six product scenarios. Public-preview separately binds nine screenshot contexts, registry-declared viewport/locale/zoom quality contexts, nine PNG SHA-256 values, visual-input and quality-policy summaries, runtime/layout/sanitization/quality audits, per-image quality reports, the complete quality matrix, and evidence-file digests. Only an explicit anonymous scenario may retain a raw trace in the private local directory; user, admin, and every unknown or future role do not start tracing. A failed scenario may retain a viewport screenshot locally, but CI never uploads fixtures/** or runs/**, whether the run succeeds or fails.

## Run

Materialize the immutable production build receipt for the current source identity, then run:

~~~bash
npm --prefix src/frontend run check:browser-contract
~~~

The caller must provide FSUSBLOG_TEST_SOURCE_COMMIT, FSUSBLOG_TEST_SOURCE_FINGERPRINT, and FSUSBLOG_BROWSER_CONTRACT_BUILD_RECEIPT. The lane defaults to the repository's tests/browser-contract/default-fixture-provider.mjs, or may receive an explicit provider implementing the same protocol. Runtime URL, fixture root, and namespace come from the current run identity and producer; they must not point to a previous run. Release Final cannot skip the build receipt, fall back to system Chrome, share fixtures, or hide failure with retry.

## Test layering and authoritative owners

tests/browser-contract/invariant-owners.json is the machine-checkable owner map for Browser Contract invariants. Each invariant has exactly one canonical test:

- tests/tools/browser-contract.test.mjs owns the catalog, schema, declarative fixed topology, forbidden runner/adapter interfaces, and evidence-retention policy.
- tests/browser-contract/fixture-lifecycle.test.mjs owns the namespace/resource isolation that must execute, provider ownership, startup/runtime/cleanup failure, retry, signal, and final-receipt behavior.
- The static layer must not use source regexes to claim that cleanup or finalization executed; the dynamic layer must not repeat fixed session/concurrency constants.

The registry itself statically checks schema, unique invariant IDs, unique owners, layer-to-file mapping, and owner-test existence. Matrix and coverage registries consume it as release-browser-contract evidence. A test rename or merge must update the retention-replacement ledger; no compatibility shell or skip is retained.

## Risk and fallback

When Browser Contract fails, Release Final remains blocked and the receipt's product, contract, or infra classification directs diagnosis; browserless production correctness is not rewritten. The same idempotent cleanup runs for success, failure, cancellation, and timeout. Cleanup failure is recorded separately, does not overwrite the first product/contract failure, and retains private recovery state for retry. If container/PID ownership cannot be proved, fail closed; never force-delete by name.

An emergency fallback may pause Release Final publication while retaining the browserless gate. It cannot restore the old Acceptance matrix, system browser, shared public schema, or automatic retries that manufacture a clean pass. Nightly/manual visual, cross-browser, geometry, and performance diagnostics are owned separately by the [#1148 browser diagnostics](issue-1148-browser-diagnostics.md).

## Release assets and Service Worker compatibility

Browser Contract's offline scenario proves the public-cache boundary of the current release. Blue/Green publication additionally requires the independent N/N-1 retained-asset scenario in the [zero-downtime release qualification runbook](../releases/zero-downtime-release-runbook.md). Before and after the real gateway switch, that scenario reads the old release's manifest, HTML, Service Worker, and immutable assets, then rereads protected URLs after GC. When browser.required=true, an HTTP-only probe cannot replace the controlled-browser checkpoint.

Browser evidence binds release ID, asset-manifest hash, gateway generation, Service Worker script/cache identity, and an independent HMAC key. Templates, Playwright test source, historical receipts, and browser.required=false cannot claim that an execution passed. Private/authenticated traffic must not enter Cache Storage; the long-term rule is canonical in the [Service Worker private-cache boundary](../security/service-worker-cache-boundary.md).

## Public-preview quality evidence

The public-preview gallery is audited inside the existing single Chromium launch. tests/browser-contract/public-preview-gallery.mjs captures nine managed PNG contexts, runs the registry's additional viewport/locale/zoom scenarios, and calls the same tools/docs/public-preview-quality.mjs facade as the formal documentation writer. It does not implement a parallel screenshot service.

PNG provenance remains in docs/assets/screenshots/manifest.json; geometry, locale, and deterministic reviewer results remain in the separate docs/assets/visual-evidence/public-preview-quality.json. Browser Contract compares both with a fresh same-source capture and augments .tmp/release-evidence/public-preview-screenshots.json. A missing, stale, tampered, fail, or needs-design-review quality manifest is a product failure, not an infrastructure-retry condition. No issue comment, CI URL, or external visual service is required for the local decision.
