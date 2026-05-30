import { getSharedPublicPageManifestEntry } from '@/public-renderers/generated/publicPageManifest'

export const PUBLIC_FIXED_PAGE_KIND = Object.freeze({
  home: 'Home',
  about: 'About',
  archive: 'Archive'
} as const)

export type PublicFixedPageKind = typeof PUBLIC_FIXED_PAGE_KIND[keyof typeof PUBLIC_FIXED_PAGE_KIND]

export const PUBLIC_FIXED_ROUTE_KEYS = Object.freeze({
  home: getSharedPublicPageManifestEntry('Home').canonicalSlug,
  about: getSharedPublicPageManifestEntry('About').canonicalSlug,
  archive: getSharedPublicPageManifestEntry('Archive').canonicalSlug
} as const)

export const PUBLIC_FIXED_PATHS = Object.freeze({
  home: '/',
  about: `/${PUBLIC_FIXED_ROUTE_KEYS.about}`,
  archive: `/${PUBLIC_FIXED_ROUTE_KEYS.archive}`
} as const)

export function buildPublicFixedRouteKey(kind: PublicFixedPageKind): string {
  if (kind === PUBLIC_FIXED_PAGE_KIND.home) {
    return PUBLIC_FIXED_ROUTE_KEYS.home
  }
  if (kind === PUBLIC_FIXED_PAGE_KIND.about) {
    return PUBLIC_FIXED_ROUTE_KEYS.about
  }
  return PUBLIC_FIXED_ROUTE_KEYS.archive
}

export function buildPublicFixedPath(kind: PublicFixedPageKind): string {
  if (kind === PUBLIC_FIXED_PAGE_KIND.home) {
    return PUBLIC_FIXED_PATHS.home
  }
  if (kind === PUBLIC_FIXED_PAGE_KIND.about) {
    return PUBLIC_FIXED_PATHS.about
  }
  return PUBLIC_FIXED_PATHS.archive
}

export type PublicHomeRouteKey = typeof PUBLIC_FIXED_ROUTE_KEYS.home
