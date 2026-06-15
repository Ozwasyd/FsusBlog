# FsusUI Adapter Boundary

`src/frontend/src/fsusui/` is the FsusBlog adapter boundary for FsusUI. Code here may import `@ozwasyd/element-plus` and package subpaths, normalize them into Blog-owned names, and expose stable contracts to the rest of the application.

`src/frontend/src/components/ui/` is the Blog shell layer. Files there may compose FsusUI-backed adapters, but their props, emits, slots and copy must stay shaped around FsusBlog workflows. They must not become a second FsusUI barrel or a place for package runtime internals.

## Adapter API

The mandatory adapter surface is:

- `index.ts`: barrel for the stable adapter API.
- `appContext.ts`: app-level FsusUI injection keys.
- `feedback.ts`: programmatic message, confirm, loading and toast helpers.
- `icons.ts`: icon package re-export boundary.
- `markdown.ts`: markdown runtime and feature activation boundary.
- `primitiveAdapters.ts`: Blog primitive variants to FsusUI semantic variants.
- `renderPipeline.ts`: render-pipeline contract adapter.
- `result.ts`: FsusUI result envelope helpers.
- `theme.ts`: FsusUI theme-mode and CSS-variable runtime.

Single-purpose adapters such as `motion.ts` may live here when they import FsusUI runtime APIs directly. Add them to `index.ts` only when they are intended as general Blog adapter API; otherwise import them explicitly from call sites.

## Blog Shells

`components/ui/` contains Blog-owned shells and composition primitives, for example markdown editor wrappers, MFA/passkey modals, `SemanticTime`, `ThemeModeToggle`, `FsusBlogRouteTransition` and `UiTag`.

These files should depend on `@/fsusui/*` adapters instead of package internals. `AsyncMarkdownRenderer.ts` and `markdownEditorProvider.ts` stay in `components/ui/` because they describe Blog composition and lazy-loading policy, not FsusUI runtime ownership.

`components/ui/index.ts` is intentionally tiny. Keep it to a small curated public shell surface, capped by `check-fsusui-boundary.mjs`, so it cannot turn into a re-export dumping ground.

## Allowed Exceptions

Direct `@ozwasyd/element-plus` imports outside `fsusui/` need a narrow reason:

- bootstrap or public shell composition that must install/provide an FsusUI root component, such as `src/frontend/src/bootstrap/fullApp.ts` and `src/frontend/src/public-renderers/scaffold.ts`;
- type-only form/upload contracts in composables, such as `FormInstance` and `UploadRequestOptions`;
- tests and fixtures that intentionally assert or violate the boundary.

New runtime imports should normally be added to a named `fsusui/` adapter first, then consumed through that adapter.

## Enforcement

`tests/frontend/checks/static/check-fsusui-boundary.mjs` enforces this contract by checking deep imports, programmatic API ownership, internal selectors, markdown feature ownership, the mandatory adapter files, and the intentionally small `components/ui/index.ts` surface.
