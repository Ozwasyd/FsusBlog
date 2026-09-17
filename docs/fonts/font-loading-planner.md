# Font loading planner

`IFontLoadingPlanner` compiles one local Font Registry snapshot, scoped activation, font-token resolution, route, locale/script, and bounded content signals into `fsusblog.font.loading-plan.v1`. Planning is deterministic: it does not read the network or probe asset URLs.

## Plan contract

The planner emits:

- critical faces for the active UI and CJK roles;
- deferred faces selected by `shell`, `article`, or `admin` route, by `Hans` / `Hant` / `Jpan` / `Kore`, and by bounded code/emoji content signals;
- content-addressed local URLs in `/font-assets/<sha256>.woff2` form for installed `.fsfont` faces;
- the manifest `font-display` value, Unicode range, size, weight, and style;
- deterministic route/locale face indexes and the resolved system fallback stacks;
- a SHA-256 plan hash and bounded `fsusblog.font.loading-evidence.v1` receipt.

Loading deduplicates by content hash + weight + style, so two packages pointing to one WOFF2 face produce one load. Critical preload candidates are the active faces listed in `manifest.loading.preload`; more than four fails with `font_preload_budget_exceeded`. Callers may lower the budget, never raise it above the implementation ceiling of eight.

The planner describes local assets only. Serving installed WOFF2 bytes and admin activation are separate boundaries; it adds no HTTP endpoint. Themes may provide semantic font-token preferences, never an asset URL, raw family declaration, or remote font.

## Frontend locale font preparation

Frontend locale fonts do not use a second hand-written locale map, idle full-language preload, or global `fsus:font-loading-evidence` CustomEvent.

`tools/contracts/generate-locale-catalog.mjs` projects the enabled locale catalog into `src/frontend/src/locales/localeFontCatalog.ts`. Script roles map to bundled Fontsource artifacts only:

```text
Hans -> Noto Sans SC
Hant -> Noto Sans TC
Jpan -> Noto Sans JP
Kore -> Noto Sans KR
Latn -> Google Sans (Latin / Latin Extended representative glyphs)
Cyrl -> Google Sans (Cyrillic representative glyphs)
```

Weights are exactly `400` / `500` / `700`; catalog keys are the enabled locale codes. `zh-Hant` remains Traditional Han and never aliases to `zh-TW`.

`src/frontend/src/bootstrap/fontPreparationPort.ts` is the pure preparation port:

```text
prepareLocaleFonts(locale, weights, signal?)
peekPreparedLocaleFonts(locale)
```

The port selects catalog faces, loads only the target script CSS entry under `src/frontend/src/assets/fonts/`, validates representative glyphs through `document.fonts`, deduplicates concurrent loads, and returns a receipt bound to locale, script, face IDs, weights, catalog digest, and monotonic generation. It does not mutate active locale, document metadata, cookies, router/Vue state, storage, or API clients. Failure/abort returns no successful receipt and stays retryable; callers must not commit a locale transaction after preparation fails.

Code fonts are independent: `codeFontPreparation.ts` loads JetBrains Mono for a code surface. `scheduleNonCriticalResources()` may prepare code fonts and telemetry on idle, but must not request other-locale CJK faces.

Locale-generation callers may prepare domain bundles and fonts in parallel, but commit only when both succeed. Server-resolved first-paint critical faces belong to the public asset/AOT plan, not a client all-language preload.

Vite owns content hashes for bundled CSS and Fontsource WOFF2 assets; installed `.fsfont` assets use the registry SHA-256 directly.

## Evidence and release boundary

Backend consumers serialize the bounded receipt with `FontLoadingPlanner.SerializeEvidence`. Frontend preparation returns a typed `fontPreparationPort` receipt instead of a global DOM event. Receipts contain no font bytes, filesystem paths, credentials, or remote URLs.

These are issue-level machine receipts. The three-round Production Fresh / release-final run remains final release acceptance and is not run by the planner. Asset-byte and CLS policy belongs to the later Font Asset Budget / CLS gate; preparation must not hide CLS by shrinking type or truncating text.

## Failure and no-restart rollback

Invalid route/preload policy fails before a plan returns. Missing scopes, disabled fonts, category mismatches, or invalid manifests use the built-in role and set `usedSafeFallback`. Locale preparation failures reject the call and keep the caller's previous locale transaction state.

Rollback does not require a restart:

1. Activate the five built-in font IDs for the affected scope.
2. Let the next plan observe the incremented activation `configVersion`.
3. Disable optional route/locale triggers at the caller while retaining the critical bundle and fallback variables.

No fallback path downloads a remote font or publishes a package.
