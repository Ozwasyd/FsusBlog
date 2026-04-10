# Public AOT Scaffold

## Goal
Use one low-coupling, high-cohesion entry for public-page AOT and hydration.

## Add A New Public Page
1. Define payload type in `types.ts`.
2. Create renderer component `PublicXxxPage.vue`.
3. Register it once in `registry.ts`.
4. Add `renderPublicXxxBundle()` in `renderPublicPage.ts` by calling `renderPublicBundle(payload)`.
5. Server injects `pageKind + hydrationPropsJson` with the same contract.

## Rules
- Never add page-component `switch` in multiple files.
- Component resolution must come from `registry.ts`.
- Keep `payload.pageKind` as the contract key for both AOT render and hydration.
