# Issue #1285 touch-target floor

## Contract

The retired 36px (`2.25rem`) control tier is not a valid `min-height` in
`src/frontend/src`. Interactive height follows the surface that owns the action:

| Surface | Minimum target | Covered controls |
| --- | --- | --- |
| public | 40px | theme menu items and the six landscape header controls |
| identity | 44px | identity-center actions, comment deletion, and mobile message creation |
| admin | 40px | article trash/write actions, audit actions, settings/user-table actions, console maintenance links, and compact analytics rows |

The title input inside the admin article editor also uses the 40px compact tier,
even though its outer wrapper is taller. This prevents an inner 36px control from
reappearing when editor spacing changes.

## Geometry ownership

Raising the landscape public-header controls from 36px to 40px does not introduce
a fixed sticky offset. `[data-public-shell-header]` remains the only measurement
anchor. `usePublicStickyGeometry` observes its rendered height and republishes
`--fsusblog-public-header-height-current`, `--fsusblog-public-sticky-top`, and
`--fsusblog-public-anchor-offset` after header reflow or viewport resize.

SSR/AOT keeps the existing static fallback until hydration publishes the measured
height. Archive sticky headings and hash targets continue to consume the derived
tokens; they do not copy the four-pixel control delta.

## Regression ownership

`check:visual-density-governance` recursively scans CSS, Vue, SCSS, and TypeScript
production sources for `min-height: 36px` and `min-height: 2.25rem`. It also pins
the public 40px, identity 44px, and admin 40px selectors that define this change.

`usePublicStickyGeometry.test.ts` retains executable coverage for an observed
header-height change, derived token publication, viewport resize, and cleanup.
The focused acceptance command remains:

```bash
rg -n "min-height:\s*(36px|2\.25rem)" src/frontend/src
```

An empty result is required.

## Risk and fallback

This change only increases CSS minimum sizes. It does not change routes, auth,
notification stream, binary contracts, or API payloads. Reverting the size rules
is sufficient to roll back the visual change without restarting the service;
sticky geometry continues to measure whichever header height is rendered.
