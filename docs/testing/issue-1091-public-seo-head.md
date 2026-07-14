# Issue #1091 — Public SEO head contract verification

## Authoritative contract

`src/shared/Contracts/Outputs/PublicSeoHeadContracts.cs` is the only field/version/digest authority. The server document composer renders that model into AOT HTML and embeds the same serialized model marker. The navigation snapshot carries the model as `seoHead`; the browser validates and stages it before committing either the route seed or the head.

An atomic commit replaces title, description, robots, canonical, Open Graph, Twitter, feed discovery, JSON-LD and the model marker. `publicOrigin` is explicit and must match canonical, Open Graph and page-entity origins, including when a local preview proxy has a different request origin. Runtime CSP, nonce, theme, Vite and favicon nodes are outside the replacement set. Non-public routes remove the entire public set before applying their own title.

## Verification matrix

| Scenario | Required assertion |
|---|---|
| anonymous direct load / no JavaScript | AOT HTML contains one complete, escaped model and one canonical |
| anonymous hydration / first takeover | current AOT model remains until a verified snapshot commits atomically |
| Home → article A → article B → archive → category → tag → Home | title, description, canonical, OG URL and JSON-LD entity match every route; one canonical and one page graph only |
| back / forward | retained versioned model restores the previous route without stale `BlogPosting` |
| prewarmed and non-prewarmed public navigation | both must use the same snapshot validation and final model |
| schema/version/digest/origin/path mismatch | no seed/head partial commit; full-document navigation fallback |
| login/admin route after article | article canonical, OG and JSON-LD are absent; app route title is restored |
| notification stream-only state update | no route snapshot is committed, so canonical/JSON-LD are not rewritten |
| binary navigation snapshot | AEDS envelope contains the same schema/version/digest model used by AOT HTML |

Unit coverage lives in `PublicAotDocumentComposerTests`, `PublicAotShellServiceTests`, `publicSeoHead.test.ts`, `publicRoutePreload.test.ts` and `publicNavigationSnapshotContract.test.ts`. The production browser SEO route matrix is the final acceptance gate and must not be replaced by static source assertions.

## Risk and rollback

The principal risk is accepting a mixed old/new snapshot or partially replacing the page head. Both fail closed: an invalid contract is not stored and the browser performs a full navigation. A rollback therefore does not require a server restart: disable public SPA takeover or force document navigation while AOT HTML continues serving; `Cache-Control: no-cache` forces snapshot revalidation. Do not roll back by accepting an old schema or bypassing digest/origin checks.
