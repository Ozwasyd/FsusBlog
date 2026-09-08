# Public AOT Scaffold

## Goal

Use one low-coupling, high-cohesion entry for public-page AOT and hydration.

Cross-language page identity is no longer authored here. `pageId / canonicalSlug / seoEligible / aotShellReady / deferSpaBoot` and shared route primitives (`article / category / tag / tag-name / search`, plus `/article/`, `/search`, and `/user/profile`) originate in `src/shared/Contracts/Outputs/PublicPageContracts.cs` and generate `generated/publicPageManifest.ts`. `publicRenderBase.ts` owns the frontend page-kind/base-payload contract; `publicFixedPageSemantics.ts` owns fixed `Home/About/Archive` kind/routeKey/path semantics; `publicRouteRegistry.ts` owns frontend route registration/name grouping; `publicPageModel.ts` only binds active navigation; `publicRouteIdentity.ts` only composes/parses runtime values.

## Add a public page

1. Update `src/shared/Contracts/Outputs/PublicPageContracts.cs`, then run `npm run generate:public-page-manifest` for `generated/publicPageManifest.ts`.
2. Define the payload in `types.ts`.
3. Register the route in `publicRouteRegistry.ts`, active-nav binding in `publicPageModel.ts`, and route-key rules in `publicRouteIdentity.ts`.
4. Add SSR assembly in `pageAssemblies.ts`; register its builder once in `publicEntryRegistry.ts`.
5. Keep `renderPublicPage.ts` a thin façade. The server injects the inline bootstrap AEDS payload and exposes `hydrationPropsPayload` as a raw `.aeds` sidecar referenced by the public hydration marker; sidecars use `application/vnd.fsus.aeds` and content-hash immutable URLs.

## Rules

- Never duplicate page route/pageId/routeKey rules.
- `PublicPageRegistry` and `PublicRouteIdentityRegistry` own cross-language page identity, route tokens, and shared paths (including account root). The frontend registry owns route names and child definitions; `publicPageModel.ts` only binds active navigation.
- `publicRenderBase.ts` owns `PublicPageKind` and the shared AOT bootstrap/hydration base payload; `publicPageModel.ts` does not carry them. Consumers needing `pageId` or `canonicalSlug` read the generated manifest directly.
- `publicRouteIdentity.ts` must not hardcode `'Search' / 'Category' / 'TagById' / 'Tag'`; filter-route names belong to `publicRouteRegistry.ts`. Fixed `Home/About/Archive` kind/routeKey/path semantics belong to `publicFixedPageSemantics.ts`; paths and payloads only consume it.
- `publicFilterSemantics.ts` owns `category/tag/search` unions, labels, and search-sort visibility. AOT assembly and `FilterView.vue` consume it rather than reimplementing `filterType === 'search'`.
- AOT click bridges and public view contracts use `publicNavigationTargets.ts`; do not hardcode `Home`, `ArticleDetail`, or `/article/:id` outside the route control plane.
- `publicRouteIdentity.ts` composes runtime routeKey/canonical/path values, not cross-language literals. `publicRoutePaths.ts` exports fixed/search paths; shell/layout components must not hardcode `/`, `/about`, `/archive`, or `/search`.
- `publicEntryRegistry.ts` owns page bootstrap/hydration/assembly. Each builder declares its kind once, and `createPublicEntryScope(...)` fans it into base model, shell, and final encoding. `publicPayloadNormalizer.ts` derives a missing routeKey through `publicRouteIdentity.ts`, never an ad-hoc `pageKind` template. `renderPublicPage.ts` remains a façade so SSR is not tied to a monolithic builder.
