# Issue #1021 public chrome handoff

This handoff maps the landed source to the issue acceptance contract. It is not runtime evidence and does not claim that the deferred validation matrix has passed.

## Landed behavior

- `PublicBlogLayoutShell.vue` mounts the real FsusUI `ElPublicShell` through the `FsusUiPublicShell` consumer alias. The alias-owned `.el-public-shell` root carries both the FsusUI `data-mobile-nav-mode="menu"` contract and the consumer handoff marker.
- Desktop keeps brand, three editorial navigation links and low-noise actions in the header. Search is a native `/search` link until enhanced; no desktop `el-input` exists before the adjacent panel is opened.
- Mobile uses FsusUI's built-in anchor trigger with native `href="/search"`. Its toolbar is collapsed until an unmodified click opens the input; the trigger carries an accessible name, `aria-expanded` and `aria-controls`, and Escape closes search and restores trigger focus. Modified clicks and no-JavaScript navigation retain the native link path.
- The explicit FsusUI `menu` mode owns the native `details/summary` disclosure through `.el-public-shell__mobile-nav-menu*` classes. Its panel contains the three `.el-public-shell__mobile-nav-link` navigation links plus a consumer-provided utility group for theme and authentication; FsusUI owns the slot but never owns Blog navigation copy. Escape closes the disclosure and restores summary focus.
- Both desktop and mobile theme controls explicitly use FsusUI's `menu-button` variant. The mobile first row stays limited to the FsusUI menu and search triggers; theme and authentication remain lower-weight utilities inside the disclosed menu.
- `PublicComplianceFooter.vue` renders brand/copyright plus RSS in the primary colophon row. License, policy, filing and return-to-top links are secondary.
- The public shell does not select FsusUI's `bottom` mode or render `FsuBottomTabBar`; footer-only safe-area padding replaces fixed-dock ghost space, so a page-level reading dock cannot overlap global bottom navigation supplied by this shell.
- `docs/public-layout-rules.md` records the consumer decision and the no-JS, hydration, keyboard, narrow-screen and theme invariants.

## Direct test owners

- `tests/frontend/checks/public/check-public-header-material.mjs` covers desktop/mobile widths, Light/Dark/system themes, guest/admin authentication, the direct alias-owned shell root, explicit `menu` mode, FsusUI-owned menu classes, mobile primary-action ownership, native `/search` fallback, collapsed/enhanced search focus and Escape behavior, menu Escape behavior, colophon structure and absence of every bottom-tab marker.
- `tests/frontend/e2e/visual/public-visual.spec.ts` checks the same FsusUI ownership boundary on the hydrated home route: three menu navigation links, the consumer theme/auth utility slot, native search href, collapsed toolbar, Escape focus restoration, no BottomTabBar and the two-row colophon. The public hydration smoke exercises the shared AOT/hydrated shell surface separately.

## Risk and rollback

The native `/search` anchor and `details/summary` navigation remain usable without JavaScript. If enhanced search fails, operators can disable SPA takeover without a restart and retain native search and menu navigation; theme and authentication stay visible as primary actions. Do not select `mobileNavMode="bottom"` or re-enable a fixed bottom tab bar while any reading dock is present.

## Validation status

No test, build, lint, syntax, governance or browser command was run during the code-landing phase. All executable evidence remains pending the unified validation phase.
