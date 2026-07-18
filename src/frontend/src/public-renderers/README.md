# Public AOT Scaffold

## Goal

Use one low-coupling, high-cohesion entry for public-page AOT and hydration.

Cross-language page identity metadata is not authored here anymore. `pageId / canonicalSlug / seoEligible / aotShellReady / deferSpaBoot` and shared route identity primitives (`article / category / tag / tag-name / search`, plus shared paths like `/article/`, `/search`, and `/user/profile`) originate from `src/shared/Contracts/Outputs/PublicPageContracts.cs` and are generated into `generated/publicPageManifest.ts`; `publicRenderBase.ts` owns the shared frontend page-kind/base-payload contract, `publicFixedPageSemantics.ts` owns the fixed public-page `Home/About/Archive` kind/routeKey/path bridge, `publicRouteRegistry.ts` owns frontend public route registration/name grouping, `publicPageModel.ts` only binds active nav on top of that registry, and `publicRouteIdentity.ts` only implements runtime composition/parsing on top of the shared tokens.

## Add A New Public Page

1. Update `src/shared/Contracts/Outputs/PublicPageContracts.cs`, then regenerate `generated/publicPageManifest.ts` via `npm run generate:public-page-manifest`.
2. Define payload type in `types.ts`.
3. Add the public route registration in `publicRouteRegistry.ts`, active-nav binding in `publicPageModel.ts`, and route key rules in `publicRouteIdentity.ts`.
4. Create page SSR assembly in `pageAssemblies.ts`.
5. Register the page entry builder once in `publicEntryRegistry.ts`.
6. Keep `renderPublicPage.ts` as a thin façade only.
7. Server injects the inline bootstrap AEDS payload and exposes `hydrationPropsPayload` as a raw `.aeds` sidecar referenced by the public hydration marker; sidecars use `application/vnd.fsus.aeds` and content-hash immutable URLs.

## Rules

- Never add page route/pageId/routeKey rules in multiple files.
- Shared `PublicPageRegistry` and `PublicRouteIdentityRegistry` own cross-language page identity metadata, route tokens and shared paths (including account root path); `publicRouteRegistry.ts` owns frontend route names + router child route definitions, and `publicPageModel.ts` only owns active-nav binding on top of that registry.
- `publicRenderBase.ts` owns the frontend `PublicPageKind` type and the shared bootstrap/hydration base payload shape used by AOT entry builders; `publicPageModel.ts` should not carry those rendering primitives anymore.
- Any frontend code that needs shared `pageId` or `canonicalSlug` must read `generated/publicPageManifest.ts` directly; do not route that metadata through `publicPageModel.ts`.
- `publicRouteIdentity.ts` must not hardcode `'Search' / 'Category' / 'TagById' / 'Tag'`; filter-route name semantics belong to `publicRouteRegistry.ts`.
- `Home/About/Archive` fixed-page kind, routeKey and path semantics belong to `publicFixedPageSemantics.ts`; `publicRoutePaths.ts`, `publicRouteIdentity.ts` and payload types should only consume that module.
- `category/tag/search` filter semantics and labels belong to `publicFilterSemantics.ts`; entry builders, payload types, filter runtime and route identity should not each re-author that union or label mapping.
- Filter 页的 search-sort 显隐语义也属于 `publicFilterSemantics.ts`；AOT page assembly 与 runtime `FilterView.vue` 都只消费该 helper，不要各自再写 `filterType === 'search'` 决策。
- Public article/home navigation targets used by AOT click bridges and public view contracts must go through `publicNavigationTargets.ts`; do not hardcode `Home`, `ArticleDetail`, or `/article/:id` outside the route control plane.
- `publicRouteIdentity.ts` owns runtime routeKey/canonical/path composition, not cross-language bucket or path literals.
- `publicRoutePaths.ts` owns frontend fixed/search path exports; public shell/layout components should never hardcode `/`, `/about`, `/archive`, or `/search`.
- `publicEntryRegistry.ts` owns page-specific bootstrap/hydration/page-assembly composition.
- Inside `publicEntryRegistry.ts`, each builder should declare its page kind only once; `createPublicEntryScope(...)` must fan that same kind into base model creation, shell rendering and final entry encoding.
- `publicPayloadNormalizer.ts` must derive missing `routeKey` values via `publicRouteIdentity.ts`, never by ad-hoc string templates based on `pageKind`.
- `renderPublicPage.ts` must stay a façade so server SSR does not depend on a monolithic builder file.
