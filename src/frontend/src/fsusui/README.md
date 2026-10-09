# FsusUI Adapter Boundary

`src/frontend/src/fsusui/` is the FsusBlog adapter boundary for FsusUI: code here may import `@ozwasyd/element-plus` and package subpaths, normalize them into Blog-owned names, and expose stable application contracts. `src/frontend/src/components/ui/` is the Blog shell layer; its files may compose FsusUI-backed adapters, but props, emits, slots, and copy must stay shaped around FsusBlog workflows rather than becoming a second FsusUI barrel or package-runtime internals.

## Adapter API

Every boundary file has one primary responsibility. A mixed file is classified by
the behavior it adds beyond its package re-exports.

| Classification | Files | Responsibility |
| --- | --- | --- |
| Type-preserving re-export | `dangerZone.ts`, `dataList.ts`, `icons.ts`, `keyValueGrid.ts`, `kpiGroup.ts`, `metricPrimitives.ts`, `overlay.ts`, `sectionHeader.ts`, `sectionNav.ts`, `segmentedControl.ts`, `settingsSection.ts`, `siteHeader.ts`, `taskPageHeader.ts`, `theme.ts`, `typedConfirmField.ts` | Rename public package exports without widening component props, slots or emits. `settingsSection.ts` is also the canonical resource-list, metadata-row and inline-actions boundary. |
| Runtime adapter | `appContext.ts`, `authoringCommands.ts`, `feedback.ts`, `markdown.ts`, `markdownOutline.ts`, `motion.ts`, `result.ts` | Own package runtime setup or invocation that cannot be represented by a re-export alone. |
| Semantic policy adapter | `blogMotion.ts`, `dialog.ts`, `primitiveAdapters.ts`, `publicShell.ts`, `renderPipeline.ts` | Map an explicit Blog policy to a public FsusUI contract without duplicating package markup or CSS. |
| Barrel | `index.ts` | Publish the stable Blog-side adapter surface; it contains no implementation. |

Type-preserving component adapters must use named re-exports; `as Component`, namespace casts, and one-line wrapper components erase package prop, slot, and emit types and are forbidden. Runtime adapters are allowed only when they install a provider, activate a package runtime, invoke a programmatic API, or translate a real FsusBlog policy. Semantic adapters may choose policy values but must not copy generic FsusUI DOM, styles, or internal BEM selectors into Blog code.

`taskPageHeader.ts` is the only account/admin task-heading boundary. It re-exports the upstream `FsusTaskPageHeader` as `FsusUiTaskPageHeader`, preserving typed props and slots. FsusBlog owns page copy, actions, and the composition margin after the header; it must not recreate the component's title, description, action layout, or mobile stacking CSS.

Identity and profile settings must consume the generic settings/resource primitives through this boundary. FsusBlog owns account data, security policy, confirmation flows, and copy; it must not recreate generic resource rows, metadata layout, inline action placement, empty states, or destructive panels.

`publicShell.ts` re-exports the alias-resolved `ElPublicShell` component and defines the stable `inline | menu | bottom | none` mobile-navigation policy. `PublicBlogLayoutShell` selects `menu` explicitly; workspace alias resolution is source consumption, not an npm publication.

`theme.ts` re-exports the FsusUI public theme-mode contract. It must import `ThemeMode`, `ResolvedTheme`, `themeModes`, `normalizeThemeMode`, `syncThemeMode`, and test helpers from `@ozwasyd/element-plus/theme` instead of declaring local equivalents.

`motion.ts` owns the auditable Blog-side motion boundary: it re-exports the FsusUI runtime (`FsuMotion`, `vMotion`, `useScrollReveal`, `runMotion`, motion types) and keeps Blog-owned surface mappings such as `FsusBlogMotionSurface` and `fsusBlogMotionPresets`. `blogMotion.ts` remains as a compatibility re-export for existing call sites. `perceptionCharacterChallenge.ts` exposes the public character primitive and protocol-neutral media types; V3 transport and workflow code consume only this adapter. Add new adapters to `index.ts` only when they are intended as general Blog adapter API; otherwise import them explicitly from call sites.

`authoringCommands.ts` owns the internal/experimental authoring-extension projection boundary. It validates closed host metadata, binds lifecycle/document/revision/selection identity, and submits accepted mutations through the public FsusUI transaction dispatcher; it does not define a browser transport, duplicate the FsusUI command registry, or expose FsusUI internals to extensions.

The article writer projects its existing inspector views through
`useArticleWriteInspectorCommands` and this same public command type. The
projection invokes the formal inspector owner with current document, admin
permission and modal state checks. Its closed receipt confirms an active,
focused inspector view only; it does not confirm remote data loading, draft
saving or publication. Cancellation suppresses late command focus and results;
underlying inspector loaders retain their existing lifecycle owner.

`articlePositionMaps.ts` preserves the public transaction/map/selection types for
the article anchor consumer. FsusUI owns node identities, ranges, affinity and
position mapping; the Blog consumer owns document binding and scroll intent.
Source aliases and a changed test pin do not establish npm package publication.

`services/authoring/articleEditorContinuity.ts` consumes these public types with
the existing document, anchor and render-cache owners. Its versioned context
contains observations from the same exposed editor instance and registered task
leases. The writer must commit an accepted public transaction to the document
owner before calling `observeTransaction`; FsusUI emits `transaction` before
`update:modelValue`. Selection and history must come from public events/results,
and focus observations must come from the writer's own focus event boundary.

Surface transitions accept only `live | source`; tool hooks accept exactly
`publish-preview-open/close` and `source-compare-open/close`. They produce anchor
plans using the existing origin, generation and manual-scroll arbitration. A
selection-only public transaction with `history: 'skip'` preserves the existing
history. Its acceptance leaves restoration `awaiting-ack` until the controlled
surface, focus and viewport owners acknowledge the current document, selection,
history, session and anchor generation. Public editor exports provide neither
selection capture nor explicit focus/viewport restoration; the adapter does not
invent these APIs or inspect private DOM. Host acknowledgements are observations,
not independent browser or accessibility qualification.

Refresh/cancellation and last-valid content remain owned by `ArticleRenderCache`.
Tool-result inspection reports admission (`eligible | stale | invalid`) for a
real document task lease; it does not verify renderer output or complete the
task. The adapter provides no tool renderer, stale banner, persisted preference,
replacement history, editor remount or cache. Product owners must separately wire
the status surface, outline/search reveal lifecycle and accessible transitions,
and verify browser rendering, layout, mobile input and reduced-motion behavior.

## Blog Shells

`components/ui/` contains Blog-owned shells and composition primitives, for example dialog wrappers, markdown editor wrappers, MFA/passkey setup modals, `SemanticTime` and `ThemeModeToggle`.

These files should depend on `@/fsusui/*` adapters instead of package internals. `AsyncMarkdownRenderer.ts` and `markdownEditorProvider.ts` stay in `components/ui/` because they describe Blog composition and lazy-loading policy, not FsusUI runtime ownership.

## Allowed Exceptions

Direct `@ozwasyd/element-plus` imports outside `fsusui/` need a narrow reason:

- type-only form/upload contracts in composables, such as `FormInstance` and `UploadRequestOptions`;
- the existing app-shell and article motion integration in `App.vue`, `bootstrap/fullApp.ts`, `ArticleImageLightbox.vue`, `useArticleImageLightbox.ts` and `useCodeBlockCopy.ts`;
- the legacy V2 perception runtime in `securityPerceptionChallengeFlow.ts` while it remains in the repository; V3 and component code use `fsusui/perceptionCharacterChallenge.ts`;
- the existing markdown editor package component in `MarkdownTextEditor.vue`;
- tests and fixtures that intentionally assert or violate the boundary.

These runtime exceptions are an explicit frozen allowlist, not precedent for new
imports. New runtime imports must be added to a named `fsusui/` adapter first,
then consumed through that adapter. Consumer code must not expose `.el-*`
internal BEM selectors as its public API; existing selector debt is frozen by
the checker allowlist.

## Theme Runtime Split

`fsusui/theme.ts` owns only the FsusUI adapter contract, providing downstream Blog code with the canonical `ThemeMode` type and theme-mode helpers from FsusUI. `src/frontend/src/services/themeRuntime.ts` remains Blog-owned; it wraps that contract with the Blog storage key, SSR boot order, Vue readonly state, and `system` mode synchronization required by the public shell.

## Enforcement

`tests/frontend/checks/static/check-fsusui-boundary.mjs` enforces this contract by checking deep imports, runtime-import ownership, type-preserving component exports, misleading local `FsusUi*` implementations, programmatic API ownership, internal selectors, markdown feature ownership, the theme adapter source and the mandatory adapter files. It checks architectural outcomes rather than requiring a particular dynamic-component rendering pattern.

## Article Editor Test Source

`config/testing/fsusui-baseline.json` selects the actual FsusUI source for local
and CI tests. Export it through `tools/test/fsusui-baseline.mjs`, then verify the
clean checkout and generated theme with the existing local identity producer.
An environment path selects that checkout and does not replace the declaration.
The current candidate combines the canonical palette key-scope and close fixes;
Blog retains its canonical composition-tail shortcut admission. Declaring this
dependency does not approve every UI path. Original focus, Writer and IME
assertions remain required, and independent product acceptance remains open.
