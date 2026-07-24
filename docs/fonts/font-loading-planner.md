# Font loading planner

`IFontLoadingPlanner` compiles one local Font Registry snapshot, scoped
activation, font-token resolution, route, locale/script, and bounded content
signals into `fsusblog.font.loading-plan.v1`. Planning is deterministic and
does not read the network or probe an asset URL.

## Plan contract

The planner emits:

- critical faces for the active UI and CJK roles;
- deferred faces selected by `shell`, `article`, or `admin` route, by
  `Hans` / `Hant` / `Jpan`, and by bounded code/emoji content signals;
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

## Existing frontend bootstrap

`BUNDLED_FONT_LOADING_PLAN` is the declarative companion for the checked-in
Fontsource bootstrap. It preserves the existing split:

```text
critical:
  Google Sans 400 / 500 / 700
  Noto Sans SC 400 / 500

deferred:
  Noto Sans SC 700
  Noto Sans TC 400 / 500 / 700
  Noto Sans JP 400 / 500 / 700
  JetBrains Mono 400 / 500 / 700
```

Only Google Sans 400/500 and Noto Sans SC 400/500 are preload candidates, so
the preload budget remains four even though Google Sans 700 stays in the
existing critical CSS path. Vite owns the content hashes for bundled CSS and
Fontsource WOFF2 build assets. Installed `.fsfont` assets use the registry
SHA-256 directly.

The idle path still schedules all previously deferred fonts through
`requestIdleCallback` (with the existing timeout fallback). The same planner
can select route, locale, or code-triggered subsets earlier. Loaded and
in-flight faces are deduplicated. A rejected dynamic CSS import emits a
`fallback` receipt, remains retryable, and never removes the checked-in
system/CJK/monospace fallback variables.

## Evidence and release boundary

Backend consumers serialize the bounded receipt with
`FontLoadingPlanner.SerializeEvidence`. The frontend dispatches
`fsus:font-loading-evidence` with the same status vocabulary and the requested,
loaded, failed, and deduplicated face IDs. Receipts contain no font bytes,
family names, filesystem paths, credentials, or remote URLs.

These receipts are issue-level machine evidence. The three-round
Production Fresh / release-final run remains the final release acceptance and
is intentionally not executed by the planner implementation. Asset-byte and
CLS policy belongs to the later Font Asset Budget / CLS gate.

## Failure and no-restart rollback

Invalid route or preload policy fails before returning a plan. Missing scopes,
disabled fonts, category mismatches, or invalid stored manifests fall back to
the built-in role and set `usedSafeFallback`. Dynamic frontend load failures
keep the fallback stack and may be retried.

Rollback does not require a restart:

1. activate the five built-in font IDs for the affected scope;
2. allow the next plan to observe the incremented activation
   `configVersion`;
3. disable optional route/locale triggers at the caller while retaining the
   critical bundle and fallback variables.

No fallback path downloads a remote font or publishes a package.
