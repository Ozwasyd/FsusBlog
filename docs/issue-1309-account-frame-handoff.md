# Issue #1309 account frame handoff

## Ownership result

`AccountLayout.vue` now owns only shared account chrome, the main-site/theme/account actions, logout, policy orchestration, and the two nested route outlets. The unnamed `/user` and `/user/manage` route records select `AccountIdentityFrame.vue` and `AdminWorkspaceFrame.vue` without changing any named leaf route.

Both area frames select their own navigation data, width mode, and page-kind policy. `AccountRouteFrame.vue` preserves the existing single Drawer, desktop rail, content scroll, and direct-child transition-key behavior. The mobile trigger is supplied by the active frame through the named `accountMobileAction` outlet, so the header is not duplicated. Drawer state is provided once by `AccountLayout` and shared only with the active frame.

CSS remains owned by `AccountLayout.vue` for this issue. The nested/teleported frame selectors use Vue `:global(...)` only so the existing declarations continue to reach the moved DOM; semantic base/identity/admin CSS ownership remains deferred to FB-08.

## Compatibility contract

- `/user/**` paths and all route names are unchanged.
- `selfMeta` and `manageMeta` remain on every named leaf, preserving session, redirect, permission, feature, policy, route-state, content-mode, and page-kind behavior.
- `/user` still resolves through `UserProfile` to `UserIdentityOverview`.
- Nested security and moderation layouts keep their concrete paths and keep a stable direct-frame-child transition key.
- Route changes close the active mobile Drawer; refresh, deep links, and browser history restore navigation state from `route.path`.

## Representative visual classification

| Surface | Desktop/mobile expectation | Classification |
| --- | --- | --- |
| Identity standard (`/user/identity`) | Existing account container, rail, header and one mobile Drawer | Structural ownership correction; no intended visual change |
| Identity takeover (`/user/messagebox`) | Existing full-width takeover content inside the identity frame | Structural ownership correction; no intended visual change |
| Admin dashboard (`/user/manage`) | Existing wide admin container and dashboard shell class | Structural ownership correction; no intended visual change |
| Admin collection (`/user/manage/article/list`) | Existing wide collection shell, rail and one mobile Drawer | Structural ownership correction; no intended visual change |

No page-body style, density, typography, card, header, or motion change is included. Any later visual divergence belongs to FB-08/FB-10 and should be treated as deferred style work; any difference outside the frame ownership boundary is an unintended regression.

## Verification targets

- Full frontend application typecheck.
- Focused router metadata, URL/deep-link, account frame, page-kind, and navigation unit tests.
- Account UX, view-constraint, visual-density, FsusUI-boundary, geometry, material, and motion static contracts.
- Local account/admin fixtures at desktop and mobile widths, including exactly one active mobile Drawer path.
