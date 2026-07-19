# FsusUI Adapter Boundary

`src/frontend/src/fsusui/` is the FsusBlog adapter boundary for FsusUI. Code here may import `@ozwasyd/element-plus` and package subpaths, normalize them into Blog-owned names, and expose stable contracts to the rest of the application.

`src/frontend/src/components/ui/` is the Blog shell layer. Files there may compose FsusUI-backed adapters, but their props, emits, slots and copy must stay shaped around FsusBlog workflows. They must not become a second FsusUI barrel or a place for package runtime internals.

## Adapter API

Every boundary file has one primary responsibility. A mixed file is classified by
the behavior it adds beyond its package re-exports.

| Classification | Files | Responsibility |
| --- | --- | --- |
| Type-preserving re-export | `dangerZone.ts`, `dataList.ts`, `icons.ts`, `keyValueGrid.ts`, `kpiGroup.ts`, `metricPrimitives.ts`, `sectionHeader.ts`, `sectionNav.ts`, `segmentedControl.ts`, `settingsSection.ts`, `siteHeader.ts`, `theme.ts`, `typedConfirmField.ts` | Rename public package exports without widening component props, slots or emits. |
| Runtime adapter | `appContext.ts`, `feedback.ts`, `markdown.ts`, `motion.ts`, `result.ts` | Own package runtime setup or invocation that cannot be represented by a re-export alone. |
| Semantic policy adapter | `blogMotion.ts`, `dialog.ts`, `pageHeader.ts`, `primitiveAdapters.ts`, `publicShell.ts`, `renderPipeline.ts` | Map an explicit Blog policy to a public FsusUI contract without duplicating package markup or CSS. |
| Barrel | `index.ts` | Publish the stable Blog-side adapter surface; it contains no implementation. |

Type-preserving component adapters must use named re-exports. `as Component`,
namespace casts and one-line wrapper components erase package prop, slot and emit
types and are forbidden. Runtime adapters are allowed only when they install a
provider, activate a package runtime, invoke a programmatic API or translate a
real FsusBlog policy. Semantic adapters may choose policy values, but must not
copy generic FsusUI DOM, styles or internal BEM selectors into Blog code.

`pageHeader.ts` owns the Blog-specific `AccountPageHeader`. Its
`FsusUiPageHeader` export is a compatibility alias for the page migration tracked
by #1304; it is not an FsusUI implementation and new call sites must use the
Blog-owned name.

`publicShell.ts` re-exports the alias-resolved `ElPublicShell` component and
defines the stable `inline | menu | bottom | none` mobile-navigation policy.
`PublicBlogLayoutShell` selects `menu` explicitly; workspace alias resolution is
source consumption, not an npm publication.

`theme.ts` re-exports the FsusUI public theme-mode contract. It must import
`ThemeMode`, `ResolvedTheme`, `themeModes`, `normalizeThemeMode`, `syncThemeMode`
and test helpers from `@ozwasyd/element-plus/theme` instead of declaring local
equivalents.

`motion.ts` owns the auditable Blog-side motion boundary: it re-exports the FsusUI runtime (`FsuMotion`, `vMotion`, `useScrollReveal`, `runMotion`, motion types) and keeps Blog-owned surface mappings such as `FsusBlogMotionSurface` and `fsusBlogMotionPresets`. `blogMotion.ts` remains as a compatibility re-export for existing call sites. `FsusPerceptionChallenge` and the perception-challenge types come from `@ozwasyd/element-plus/perception-challenge`. Add new adapters to `index.ts` only when they are intended as general Blog adapter API; otherwise import them explicitly from call sites.

## Blog Shells

`components/ui/` contains Blog-owned shells and composition primitives, for example dialog wrappers, markdown editor wrappers, MFA/passkey setup modals, `SemanticTime` and `ThemeModeToggle`.

These files should depend on `@/fsusui/*` adapters instead of package internals. `AsyncMarkdownRenderer.ts` and `markdownEditorProvider.ts` stay in `components/ui/` because they describe Blog composition and lazy-loading policy, not FsusUI runtime ownership.

## Allowed Exceptions

Direct `@ozwasyd/element-plus` imports outside `fsusui/` need a narrow reason:

- type-only form/upload contracts in composables, such as `FormInstance` and `UploadRequestOptions`;
- the existing app-shell and article motion integration in `App.vue`, `bootstrap/fullApp.ts`, `ArticleImageLightbox.vue`, `useArticleImageLightbox.ts` and `useCodeBlockCopy.ts`;
- the existing perception-challenge integration in `FsusSecurityChallenge.vue` and `securityPerceptionChallengeFlow.ts`;
- the existing markdown editor package component in `MarkdownTextEditor.vue`;
- tests and fixtures that intentionally assert or violate the boundary.

These runtime exceptions are an explicit frozen allowlist, not precedent for new
imports. New runtime imports must be added to a named `fsusui/` adapter first,
then consumed through that adapter. Consumer code must not expose `.el-*`
internal BEM selectors as its public API; existing selector debt is frozen by
the checker allowlist.

## Theme Runtime Split

`fsusui/theme.ts` owns only the FsusUI adapter contract: downstream Blog code gets the canonical `ThemeMode` type and theme-mode helpers from FsusUI through this file.

`src/frontend/src/services/themeRuntime.ts` remains Blog-owned. It wraps that FsusUI contract with the Blog storage key, SSR boot order, Vue readonly state and `system` mode synchronization required by the public shell.

## Enforcement

`tests/frontend/checks/static/check-fsusui-boundary.mjs` enforces this contract by checking deep imports, runtime-import ownership, type-preserving component exports, misleading local `FsusUi*` implementations, programmatic API ownership, internal selectors, markdown feature ownership, the theme adapter source and the mandatory adapter files. It checks architectural outcomes rather than requiring a particular dynamic-component rendering pattern.
