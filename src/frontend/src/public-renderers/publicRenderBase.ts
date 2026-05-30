import type { SharedSeoEligiblePublicPageKind } from '@/public-renderers/generated/publicPageManifest'

export type PublicPageKind = SharedSeoEligiblePublicPageKind

export type PublicRenderBase = Readonly<{
  hydrationBase: Readonly<{
    pageKind: PublicPageKind
    routeKey: string
    rendererVersion: string
    siteTitle: string
    siteDescription: string
    baseUrl: unknown
  }>
  bootstrapBase: Readonly<{
    kind: PublicPageKind
    pageKind: PublicPageKind
    routeKey: string
    rendererVersion: string
    siteTitle: string
    siteDescription: string
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
  }>
): PublicRenderBase {
  return {
    hydrationBase: {
      pageKind: kind,
      routeKey,
      rendererVersion: options.rendererVersion,
      siteTitle: options.siteTitle,
      siteDescription: options.siteDescription,
      baseUrl: options.baseUrl ?? null
    },
    bootstrapBase: {
      kind,
      pageKind: kind,
      routeKey,
      rendererVersion: options.rendererVersion,
      siteTitle: options.siteTitle,
      siteDescription: options.siteDescription
    }
  }
}