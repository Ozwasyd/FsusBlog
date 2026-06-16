// Auto-generated from src/shared/Contracts/Outputs/PublicPageContracts.cs
// Run: node ../../tools/frontend/generate-public-page-manifest.mjs

export const PUBLIC_PAGE_MANIFEST = Object.freeze({
  Home: {
    kind: 'Home',
    pageId: 1,
    canonicalSlug: 'home',
    seoEligible: true,
    aotShellReady: true,
    deferSpaBoot: true,
    requiresUserState: false,
    fallbackBehavior: 'public-aot-shell'
  },
  ArticleDetail: {
    kind: 'ArticleDetail',
    pageId: 2,
    canonicalSlug: 'article',
    seoEligible: true,
    aotShellReady: true,
    deferSpaBoot: true,
    requiresUserState: false,
    fallbackBehavior: 'public-aot-shell'
  },
  Filter: {
    kind: 'Filter',
    pageId: 3,
    canonicalSlug: 'filter',
    seoEligible: true,
    aotShellReady: true,
    deferSpaBoot: true,
    requiresUserState: false,
    fallbackBehavior: 'public-aot-shell'
  },
  Archive: {
    kind: 'Archive',
    pageId: 4,
    canonicalSlug: 'archive',
    seoEligible: true,
    aotShellReady: true,
    deferSpaBoot: true,
    requiresUserState: false,
    fallbackBehavior: 'public-aot-shell'
  },
  About: {
    kind: 'About',
    pageId: 5,
    canonicalSlug: 'about',
    seoEligible: true,
    aotShellReady: true,
    deferSpaBoot: true,
    requiresUserState: false,
    fallbackBehavior: 'public-aot-shell'
  },
  Account: {
    kind: 'Account',
    pageId: 6,
    canonicalSlug: 'account',
    seoEligible: false,
    aotShellReady: false,
    deferSpaBoot: false,
    requiresUserState: true,
    fallbackBehavior: 'user-state-runtime-only'
  },
  Privacy: {
    kind: 'Privacy',
    pageId: 7,
    canonicalSlug: 'privacy',
    seoEligible: true,
    aotShellReady: true,
    deferSpaBoot: true,
    requiresUserState: false,
    fallbackBehavior: 'public-aot-shell'
  },
  Guidelines: {
    kind: 'Guidelines',
    pageId: 8,
    canonicalSlug: 'guidelines',
    seoEligible: true,
    aotShellReady: true,
    deferSpaBoot: true,
    requiresUserState: false,
    fallbackBehavior: 'public-aot-shell'
  },
  Copyright: {
    kind: 'Copyright',
    pageId: 9,
    canonicalSlug: 'copyright',
    seoEligible: true,
    aotShellReady: true,
    deferSpaBoot: true,
    requiresUserState: false,
    fallbackBehavior: 'public-aot-shell'
  }
} as const)

export const PUBLIC_ROUTE_IDENTITY_TOKENS = Object.freeze({
  publicAotShellFallback: 'public-aot-shell',
  publicSearchSpaFallback: 'spa-public-search-fallback',
  userStateRuntimeOnlyFallback: 'user-state-runtime-only',
  searchRouteKey: 'search',
  searchPath: '/search',
  accountPath: '/user/profile',
  unknownFilterRouteKey: 'filter:unknown',
  articleBucket: 'article',
  articlePathPrefix: '/article/',
  categoryBucket: 'category',
  categoryPathPrefix: '/category/',
  tagBucket: 'tag',
  tagPathPrefix: '/tag/',
  tagNameBucket: 'tag-name'
} as const)


export type SharedPublicPageKind = keyof typeof PUBLIC_PAGE_MANIFEST

type SharedPublicPageManifest = typeof PUBLIC_PAGE_MANIFEST

type SharedPageKindsWithFlag<TFlag extends keyof SharedPublicPageManifest[SharedPublicPageKind]> = {
  [K in SharedPublicPageKind]: SharedPublicPageManifest[K][TFlag] extends true ? K : never
}[SharedPublicPageKind]

export type SharedSeoEligiblePublicPageKind = SharedPageKindsWithFlag<'seoEligible'>
export type SharedAotShellReadyPublicPageKind = SharedPageKindsWithFlag<'aotShellReady'>

export function getSharedPublicPageManifestEntry<TKind extends SharedPublicPageKind>(kind: TKind): SharedPublicPageManifest[TKind] {
  return PUBLIC_PAGE_MANIFEST[kind]
}
