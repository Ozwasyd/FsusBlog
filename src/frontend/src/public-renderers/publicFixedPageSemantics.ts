import { getSharedPublicPageManifestEntry } from '@/public-renderers/generated/publicPageManifest'

export const PUBLIC_FIXED_PAGE_KIND = Object.freeze({
  home: 'Home',
  about: 'About',
  archive: 'Archive',
  privacy: 'Privacy',
  guidelines: 'Guidelines',
  copyright: 'Copyright'
} as const)

export type PublicFixedPageKind = typeof PUBLIC_FIXED_PAGE_KIND[keyof typeof PUBLIC_FIXED_PAGE_KIND]

export const PUBLIC_FIXED_ROUTE_KEYS = Object.freeze({
  home: getSharedPublicPageManifestEntry('Home').canonicalSlug,
  about: getSharedPublicPageManifestEntry('About').canonicalSlug,
  archive: getSharedPublicPageManifestEntry('Archive').canonicalSlug,
  privacy: getSharedPublicPageManifestEntry('Privacy').canonicalSlug,
  guidelines: getSharedPublicPageManifestEntry('Guidelines').canonicalSlug,
  copyright: getSharedPublicPageManifestEntry('Copyright').canonicalSlug
} as const)

export const PUBLIC_FIXED_PATHS = Object.freeze({
  home: '/',
  about: `/${PUBLIC_FIXED_ROUTE_KEYS.about}`,
  archive: `/${PUBLIC_FIXED_ROUTE_KEYS.archive}`,
  privacy: `/${PUBLIC_FIXED_ROUTE_KEYS.privacy}`,
  guidelines: `/${PUBLIC_FIXED_ROUTE_KEYS.guidelines}`,
  copyright: `/${PUBLIC_FIXED_ROUTE_KEYS.copyright}`
} as const)

export function buildPublicFixedRouteKey(kind: PublicFixedPageKind): string {
  if (kind === PUBLIC_FIXED_PAGE_KIND.home) {
    return PUBLIC_FIXED_ROUTE_KEYS.home
  }
  if (kind === PUBLIC_FIXED_PAGE_KIND.about) {
    return PUBLIC_FIXED_ROUTE_KEYS.about
  }
  if (kind === PUBLIC_FIXED_PAGE_KIND.archive) {
    return PUBLIC_FIXED_ROUTE_KEYS.archive
  }
  if (kind === PUBLIC_FIXED_PAGE_KIND.privacy) {
    return PUBLIC_FIXED_ROUTE_KEYS.privacy
  }
  if (kind === PUBLIC_FIXED_PAGE_KIND.guidelines) {
    return PUBLIC_FIXED_ROUTE_KEYS.guidelines
  }
  return PUBLIC_FIXED_ROUTE_KEYS.copyright
}

export function buildPublicFixedPath(kind: PublicFixedPageKind): string {
  if (kind === PUBLIC_FIXED_PAGE_KIND.home) {
    return PUBLIC_FIXED_PATHS.home
  }
  if (kind === PUBLIC_FIXED_PAGE_KIND.about) {
    return PUBLIC_FIXED_PATHS.about
  }
  if (kind === PUBLIC_FIXED_PAGE_KIND.archive) {
    return PUBLIC_FIXED_PATHS.archive
  }
  if (kind === PUBLIC_FIXED_PAGE_KIND.privacy) {
    return PUBLIC_FIXED_PATHS.privacy
  }
  if (kind === PUBLIC_FIXED_PAGE_KIND.guidelines) {
    return PUBLIC_FIXED_PATHS.guidelines
  }
  return PUBLIC_FIXED_PATHS.copyright
}

export type PublicHomeRouteKey = typeof PUBLIC_FIXED_ROUTE_KEYS.home
