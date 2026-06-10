import type { SharedSeoEligiblePublicPageKind } from '@/public-renderers/generated/publicPageManifest'
import type { SiteComplianceConfigPublic } from '@/api/system'

export type PublicPageKind = SharedSeoEligiblePublicPageKind

export type PublicRenderBase = Readonly<{
  hydrationBase: Readonly<{
    pageKind: PublicPageKind
    routeKey: string
    rendererVersion: string
    siteTitle: string
    siteDescription: string
    baseUrl: unknown
    compliance: SiteComplianceConfigPublic | null
  }>
  bootstrapBase: Readonly<{
    kind: PublicPageKind
    pageKind: PublicPageKind
    routeKey: string
    rendererVersion: string
    siteTitle: string
    siteDescription: string
    compliance: SiteComplianceConfigPublic | null
  }>
}>

export function createPublicRenderBase(
  kind: PublicPageKind,
  routeKey: string,
  options: Readonly<{
    rendererVersion: string
    siteTitle: string
    siteDescription: string
    baseUrl?: unknown
    compliance?: SiteComplianceConfigPublic | null
  }>
): PublicRenderBase {
  return {
    hydrationBase: {
      pageKind: kind,
      routeKey,
      rendererVersion: options.rendererVersion,
      siteTitle: options.siteTitle,
      siteDescription: options.siteDescription,
      baseUrl: options.baseUrl ?? null,
      compliance: options.compliance ?? null
    },
    bootstrapBase: {
      kind,
      pageKind: kind,
      routeKey,
      rendererVersion: options.rendererVersion,
      siteTitle: options.siteTitle,
      siteDescription: options.siteDescription,
      compliance: options.compliance ?? null
    }
  }
}
