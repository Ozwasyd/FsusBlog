import type { SharedSeoEligiblePublicPageKind } from '@/public-renderers/generated/publicPageManifest'
import type { SiteComplianceConfigPublic } from '@/api/system'
import type { PublicRenderClock } from '@/public-renderers/publicRenderClock'

export type PublicPageKind = SharedSeoEligiblePublicPageKind

export type PublicRenderBase = Readonly<{
  hydrationBase: Readonly<{
    pageKind: PublicPageKind
    routeKey: string
    rendererVersion: string
    siteTitle: string
    siteDescription: string
    baseUrl: unknown
    siteLogoUrl?: string | null
    siteLogoDarkUrl?: string | null
    siteWordmarkUrl?: string | null
    loginLogoUrl?: string | null
    loginIconUrl?: string | null
    compliance: SiteComplianceConfigPublic | null
    renderTimestamp: string
    renderYear: number
    renderTimeZone: string
  }>
  bootstrapBase: Readonly<{
    kind: PublicPageKind
    pageKind: PublicPageKind
    routeKey: string
    rendererVersion: string
    siteTitle: string
    siteDescription: string
    siteLogoUrl?: string | null
    siteLogoDarkUrl?: string | null
    siteWordmarkUrl?: string | null
    loginLogoUrl?: string | null
    loginIconUrl?: string | null
    compliance: SiteComplianceConfigPublic | null
    renderTimestamp: string
    renderYear: number
    renderTimeZone: string
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
    siteLogoUrl?: string | null
    siteLogoDarkUrl?: string | null
    siteWordmarkUrl?: string | null
    loginLogoUrl?: string | null
    loginIconUrl?: string | null
    compliance?: SiteComplianceConfigPublic | null
    renderClock: PublicRenderClock
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
      siteLogoUrl: options.siteLogoUrl ?? null,
      siteLogoDarkUrl: options.siteLogoDarkUrl ?? null,
      siteWordmarkUrl: options.siteWordmarkUrl ?? null,
      loginLogoUrl: options.loginLogoUrl ?? null,
      loginIconUrl: options.loginIconUrl ?? null,
      compliance: options.compliance ?? null,
      renderTimestamp: options.renderClock.renderTimestamp,
      renderYear: options.renderClock.renderYear,
      renderTimeZone: options.renderClock.renderTimeZone
    },
    bootstrapBase: {
      kind,
      pageKind: kind,
      routeKey,
      rendererVersion: options.rendererVersion,
      siteTitle: options.siteTitle,
      siteDescription: options.siteDescription,
      siteLogoUrl: options.siteLogoUrl ?? null,
      siteLogoDarkUrl: options.siteLogoDarkUrl ?? null,
      siteWordmarkUrl: options.siteWordmarkUrl ?? null,
      loginLogoUrl: options.loginLogoUrl ?? null,
      loginIconUrl: options.loginIconUrl ?? null,
      compliance: options.compliance ?? null,
      renderTimestamp: options.renderClock.renderTimestamp,
      renderYear: options.renderClock.renderYear,
      renderTimeZone: options.renderClock.renderTimeZone
    }
  }
}
