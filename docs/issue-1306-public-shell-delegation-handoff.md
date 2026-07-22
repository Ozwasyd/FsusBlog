# Issue #1306 PublicShell auth/search delegation handoff

## Scope and ownership result

`PublicBlogLayoutShell.vue` now passes Blog-owned state to the local FsusUI
`ElPublicShell` contract:

- `auth-label` and `auth-href` carry the resolved public auth destination;
- `desktop-search-mode="trigger"` selects the upstream disclosure;
- search label, action, name, controlled query, placeholder, focus signal, and
  SPA search choice remain product-owned;
- PublicShell owns the auth markup, desktop disclosure state, modified-click
  fallback, focus transfer/restoration, Escape, outside pointer, CSP-safe DOM,
  and reduced-motion transition.

The Blog wrapper no longer contains a `desktop-search` slot, local expanded
state, search disclosure refs, document pointer listener, Escape handler,
focus helpers, custom transition, or manual desktop/mobile auth anchors.
`BlogLayout.vue` remains unchanged and continues to normalize the submitted
keyword through `normalizePublicSearchKeyword` before routing.

## Local alias baseline

- FsusUI #220: `9c2a6a9f28` (ancestor of local `main`)
- FsusUI #221: `84e379dde5` (local `main` HEAD used by typecheck, unit, and
  rendered validation)
- The gitignored local theme bundle was refreshed with
  `corepack pnpm run build:theme`; no FsusUI source, version, changeset, package,
  or publication was created.

## Before/after visual evidence

The fixture used the same Blog shell source and local FsusUI alias at
`1365x768` and `390x844`. Each run verified page identity, meaningful content,
no framework overlay, clean error/warning diagnostics, native auth hrefs, and
the target interaction. Desktop-open runs also verified input focus after the
ordinary search-trigger click.

The one-off before/after captures were retired after review. Current shell
composition is represented by the deterministic
[light public baseline](assets/screenshots/public-home-light.png),
[dark public baseline](assets/screenshots/public-dark.png), and their
[provenance manifest](assets/screenshots/manifest.json).

The visible changes are limited to the search/auth/action region allowed by
#1306. Brand geometry, primary navigation hierarchy, header height, footer,
and fixture content were not redesigned. Inspection found no unintended
regression in the captured states.

## Focused behavior evidence

- Blog unit coverage mounts the real alias-resolved `FsusUiPublicShell` and
  checks auth/search props, native links, controlled query updates, and SPA
  search forwarding.
- CSP/no-JS coverage server-renders the Blog wrapper and checks native search
  and auth hrefs, the CSP-safe hidden panel state, and absence of inline styles.
- FsusUI's own #221 unit suite covers ordinary versus modified trigger clicks,
  input focus, Escape focus restoration, outside-pointer close, controlled
  queries, SSR native fallback, and CSP-safe visibility.
- The existing local motion contract check covers the built FsusUI
  reduced-motion artifact used by the Blog alias.

No backend API, binary/AEDS contract, hydration payload shape, profile
settings primitive, or test-runner script changed in this issue.
