# Issue #1307 PublicShell CSS ownership handoff

## Declaration inventory and result

The consumer surface was inventoried before the transfer and now has this
ownership boundary:

| Source | Before | After |
| --- | --- | --- |
| `public-shell-foundation.css` | PublicShell header/row/actions/nav/search/auth/footer geometry; ThemeModeToggle/menu geometry; generic control, overlay, and Dialog tokens; Blog brand/footer/editorial fallback | palette and registered Consumer tokens; root first-frame sizing; stable `[data-public-shell-header]`; Blog brand, `public-colophon`, editorial fallback, and emergency source |
| `public-shell-emergency.css` | generated fallback plus two unused header material aliases | generated palette/root/editorial fallback only; no FsusUI internal selector or chrome material alias |
| `public-page.css` | reading/page declarations plus six duplicated light/dark header material aliases | reading/page/editorial declarations only; no PublicShell, ThemeModeToggle, brand, footer, or runtime-shell selector |
| `PublicBlogLayoutShell.vue` scoped style | Blog main overflow boundary and mobile utility-slot composition | unchanged; the two `.fsusblog-*` selectors remain the only scoped declarations |
| `check-fsusui-boundary.mjs` | public page had four internal-selector exemptions; foundation had ten named exemptions plus a blanket `.el-public-shell*` bypass | both public CSS files have zero exemptions; the blanket bypass is removed |

Generic control heights, responsive row layout, Search/Auth/Theme/Menu state,
focus, motion, reduced motion, overlay material, footer safe area, and internal
DOM geometry now come only from the existing FsusUI critical/runtime CSS.
FsusBlog retains product palette, brand, footer content composition, editorial
layout, and emergency fallback. No FsusUI source, package version, changeset, or
publication changed.

## SSR and hydration structure evidence

Both the `0f72edbf` baseline and the candidate were built with
`build:ssr-public` against local FsusUI `84e379dde5`. The same Home payload was
rendered through `buildPublicEntry` and `renderPublicHydrationSnapshot`:

| Phase | Before | After | Result |
| --- | ---: | ---: | --- |
| SSR first-frame HTML | 11,068 bytes, SHA-256 `aab9ad194d01f60ed863787a78e0606c88028624690d099f7a47fbb89c7301c7` | same | byte-identical |
| hydration snapshot HTML | 11,068 bytes, same SHA-256 | same | byte-identical |

Both snapshots contain meaningful article content and the stable
`data-public-shell-header` hook. This classifies the DOM/AOT transfer as
equivalent: only CSS ownership changes; SSR and hydration structure do not.

## Before/after visual evidence

The local Playwright fixture used the same Blog shell, payload, and local
FsusUI alias at `1365x768` and `390x844`. Every run verified the intended URL
and title, meaningful page content, no Vite overlay, zero page/console
error-or-warning diagnostics, native auth links, and the target interaction.
Desktop-open runs also verified that opening Search focuses its input.

| State | Before | After | Classification |
| --- | --- | --- | --- |
| desktop light, Search closed | [image](assets/screenshots/issue-1307/before-1365x768-light-desktop-closed.png) | [image](assets/screenshots/issue-1307/after-1365x768-light-desktop-closed.png) | expected FsusUI canonical nav/control spacing |
| desktop light, Search open | [image](assets/screenshots/issue-1307/before-1365x768-light-desktop-open.png) | [image](assets/screenshots/issue-1307/after-1365x768-light-desktop-open.png) | expected FsusUI canonical panel width/padding |
| desktop dark, Search open | [image](assets/screenshots/issue-1307/before-1365x768-dark-desktop-open.png) | [image](assets/screenshots/issue-1307/after-1365x768-dark-desktop-open.png) | expected FsusUI canonical panel width/padding |
| mobile light, menu open | [image](assets/screenshots/issue-1307/before-390x844-light-mobile-menu-open.png) | [image](assets/screenshots/issue-1307/after-390x844-light-mobile-menu-open.png) | expected FsusUI canonical menu padding/alignment |
| mobile dark, menu open | [image](assets/screenshots/issue-1307/before-390x844-dark-mobile-menu-open.png) | [image](assets/screenshots/issue-1307/after-390x844-dark-mobile-menu-open.png) | expected FsusUI canonical menu padding/alignment |

There are no product-owned exceptions and no observed regressions. Blog brand,
reading content, footer content/composition, light/dark palette, focus transfer,
and mobile disclosure behavior remain intact. The visible spacing changes are
the expected canonical harmonization after deleting consumer overrides.

## Focused verification

- public-shell CSS ownership, FsusUI boundary, visual density, foundation token,
  shell material, and generated emergency checks pass;
- local FsusUI typecheck and its public-shell motion contract pass;
- `PublicBlogLayoutShellDelegation` and `usePublicStickyGeometry` pass (4 tests);
- public hydration identity passes;
- before and after both hit the same unrelated `check:public-aot-contracts`
  baseline failure for the hydration registry's exact `requiredArtifacts`
  formatting, so it is not introduced or widened by this CSS-only change.

No backend API, binary/AEDS contract, route, SEO, AOT document composer,
notification stream, production runtime, or deployment path changed.
