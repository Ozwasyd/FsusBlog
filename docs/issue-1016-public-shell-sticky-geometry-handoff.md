# Issue #1016 public shell sticky geometry handoff

GitHub #1016 is already closed. Its completion comment identifies commit
`c5f98e10` as the original implementation and records historical unit, type, and
Playwright results. This pass did not treat those historical results as current
validation; it audited the shared workspace against the original acceptance
criteria. The original #1016 implementation queried `.el-public-shell__header`;
#1018 later intentionally superseded that selector with a FsusBlog-owned hook to
preserve the strict FsusUI boundary. The final state below keeps #1016's measurement
behavior while following #1018's newer selector contract.

## Geometry contract

`PublicBlogLayoutShell.vue` owns the public sticky header and publishes these inline
SSR/AOT fallbacks on `#fsus-aot-shell`:

| token | fallback value |
|---|---|
| `--fsusblog-public-header-height-current` | `var(--fsusblog-public-header-height, 4rem)` |
| `--fsusblog-public-sticky-top` | `var(--fsusblog-public-header-height-current)` |
| `--fsusblog-public-anchor-offset` | `calc(var(--fsusblog-public-sticky-top) + 0.75rem)` |

The shell calls `usePublicStickyGeometry(shellRootRef)`. After mount and `nextTick`,
the composable resolves the actual header through FsusUI's stable
`[data-public-shell-header]` hook, measures `getBoundingClientRect().height`, rounds
up to a positive pixel value, and writes all three tokens on the shell root.

Runtime lookup never depends on FsusUI's internal BEM class names. The alias-owned
`ElPublicShell` publishes the data hook, while the FsusBlog composable remains the
sole owner of geometry token calculation and ResizeObserver lifecycle.

## Selector succession

- #1016 historical state at `c5f98e10`: query the actual header by an internal
  `.el-public-shell__header` class.
- current successor state: query the same element by the public
  `[data-public-shell-header]` hook supplied by the alias-resolved FsusUI component.
- current behavior test: the fixture carries only the stable hook; lookup, initial
  measurement, resize update and cleanup do not depend on an internal class.

## Update and cleanup behavior

- `ResizeObserver` observes the actual header, covering header reflow and mobile
  search-row expansion/collapse.
- viewport `resize` re-resolves and republishes the header geometry.
- a changed header element disconnects the old observer before observing the new
  one.
- repeated identical heights do not rewrite the inline tokens.
- unmount disconnects the observer and removes the exact registered viewport
  listener.
- if JavaScript, the header, `ResizeObserver`, or a valid positive measurement is
  unavailable, the inline 4rem-derived fallback remains authoritative.

## Acceptance ownership

`tests/frontend/unit/components/usePublicStickyGeometry.test.ts` now owns:

- exact public token names;
- the exact FsusBlog-owned selector and absence of an `.el-*` query dependency;
- confirmation that the measured fixture element is the actual
  `.el-public-shell__header`;
- initial post-mount publication;
- observer-driven header resize publication;
- viewport-resize publication;
- observed-header binding;
- observer disconnect and exact resize-listener removal on unmount.

The original shell-wide source test is currently deleted by a separate shared
frontend source-locking migration. This pass did not restore or overwrite that dirty
test. SSR fallback remains directly integrated in the dirty shell file and is listed
as retained evidence in `tests/issue-1016-sticky-geometry-evidence.json`.

## Scope preserved

- no header visual style, type, spacing, color, background, shadow, or motion change;
- no archive DOM restructuring or current-year heading removal;
- no FsusUI modification;
- no edit to the dirty `PublicBlogLayoutShell.vue` or archive consumer;
- no deployment, auth/schema, dead-code governance, or central test-registry edit.

## Risk and fallback

The runtime code only writes CSS custom properties on the shell root. Removing or
disabling the observer leaves the existing static 4rem fallback, so degradation does
not require a process restart. If the app-owned header class changes, update the
shell and geometry selector in the same change; do not make downstream pages guess
a new height or query a FsusUI internal class.

## Validation status

No test, build, lint, restore, syntax, typecheck, profile, Playwright, screenshot, or
browser validation was executed in this implementation phase. Current-workspace
verification remains deferred even though the historical GitHub comment reports that
the original commit passed its then-current checks.
