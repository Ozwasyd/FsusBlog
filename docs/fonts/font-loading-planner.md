# Font loading planner

`IFontLoadingPlanner` compiles one local Font Registry snapshot, scoped
activation, font-token resolution, route, locale/script, and bounded content
signals into `fsusblog.font.loading-plan.v1`. Planning is deterministic and
does not read the network or probe an asset URL.

## Plan contract

The planner emits:

- critical faces for the active UI and CJK roles;
- deferred faces selected by `shell`, `article`, or `admin` route, by
  `Hans` / `Hant` / `Jpan` / `Kore`, and by bounded code/emoji content signals;
- content-addressed local URLs in
  `/font-assets/<sha256>.woff2` form for installed `.fsfont` faces;
- the manifest `font-display` value, Unicode range, size, weight, and style;
- deterministic route/locale face indexes and the resolved system fallback
  stacks;
- a SHA-256 plan hash and bounded
  `fsusblog.font.loading-evidence.v1` receipt.

Face identity for loading deduplication is content hash + weight + style.
Two activated packages that refer to the same WOFF2 face therefore produce
one load. Critical preload candidates are the active faces explicitly listed
in `manifest.loading.preload`; more than four preloads fail with
`font_preload_budget_exceeded`. A caller may lower that budget, but cannot
raise it above the implementation ceiling of eight.

The planner only describes local assets. Serving installed WOFF2 bytes and
admin activation are separate boundaries; this issue adds no HTTP endpoint.
Themes may supply semantic font-token preferences, but cannot supply an asset
URL, raw family declaration, or remote font.

## Frontend locale font preparation

Frontend locale fonts no longer use a second hand-written locale map, idle
full-language preload, or a global `fsus:font-loading-evidence` CustomEvent.

`tools/contracts/generate-locale-catalog.mjs` projects the enabled locale
catalog into `src/frontend/src/locales/localeFontCatalog.ts`. Script roles map
to bundled Fontsource artifacts only:

```text
Hans -> Noto Sans SC
Hant -> Noto Sans TC
Jpan -> Noto Sans JP
Kore -> Noto Sans KR
Latn -> Google Sans (Latin / Latin Extended representative glyphs)
Cyrl -> Google Sans (Cyrillic representative glyphs)
```

Weights are the fixed set `400` / `500` / `700`. Catalog keys are exactly the
enabled locale codes; `zh-Hant` remains Traditional Han and never aliases to
`zh-TW`.

`src/frontend/src/bootstrap/fontPreparationPort.ts` is the pure preparation
port:

```text
prepareLocaleFonts(locale, weights, signal?)
peekPreparedLocaleFonts(locale)
```

The port selects faces from the catalog, loads only the target script CSS
entry under `src/frontend/src/assets/fonts/`, validates representative glyphs
through `document.fonts`, deduplicates concurrent face loads, and returns a
receipt bound to locale, script, face ids, weights, catalog digest, and a
monotonic generation. It does not mutate active locale, document metadata,
cookies, router state, Vue component state, storage, or API clients. Failure
and abort leave no successful receipt and remain retryable; callers must not
commit a locale transaction after a preparation failure.

Code fonts are independent: `codeFontPreparation.ts` loads JetBrains Mono when
a code surface is present. `scheduleNonCriticalResources()` may prepare those
code fonts and telemetry on idle, but must not request other-locale CJK faces.

Locale-generation callers (for example a later locale transaction port) may
prepare domain bundles and fonts in parallel and commit only when both succeed.
Server-resolved first-paint critical faces remain owned by the public asset /
AOT plan, not by a client-side all-language preload.

Vite owns content hashes for bundled CSS and Fontsource WOFF2 build assets.
Installed `.fsfont` assets continue to use the registry SHA-256 directly.

## Evidence and release boundary

Backend consumers serialize the bounded receipt with
`FontLoadingPlanner.SerializeEvidence`. Frontend locale preparation returns a
typed receipt from `fontPreparationPort` instead of broadcasting a global DOM
event. Receipts contain no font bytes, filesystem paths, credentials, or remote
URLs.

These receipts are issue-level machine evidence. The three-round
Production Fresh / release-final run remains the final release acceptance and
is intentionally not executed by the planner implementation. Asset-byte and
CLS policy belongs to the later Font Asset Budget / CLS gate; preparation must
not hide CLS by shrinking type or truncating representative text.

## Failure and no-restart rollback

Invalid route or preload policy fails before returning a plan. Missing scopes,
disabled fonts, category mismatches, or invalid stored manifests fall back to
the built-in role and set `usedSafeFallback`. Frontend locale preparation
failures reject the prepare call and keep the previous locale transaction
state at the caller.

Rollback does not require a restart:

1. activate the five built-in font IDs for the affected scope;
2. allow the next plan to observe the incremented activation
   `configVersion`;
3. disable optional route/locale triggers at the caller while retaining the
   critical bundle and fallback variables.

No fallback path downloads a remote font or publishes a package.
