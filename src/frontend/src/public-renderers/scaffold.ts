import { h, type Component, type VNode, type VNodeChild } from 'vue'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import type { SiteComplianceConfigPublic } from '@/api/system'
import type { PublicPageKind } from '@/public-renderers/publicRenderBase'
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState'
import type { SupportedLocale } from '@/locales'

export type PublicHydrationPageKind = PublicPageKind

export type PublicAotPageSlot = () => VNodeChild

export type PublicAotPageAssembly = Readonly<{
  component: Component
  props: Readonly<Record<string, unknown>>
  slots?: Readonly<Record<string, PublicAotPageSlot>>
}>

export type PublicAotShellAssembly = Readonly<{
  kind: PublicPageKind
  siteTitle: string
  siteDescription?: string | null
  siteLogoUrl?: string | null
  siteLogoDarkUrl?: string | null
  siteWordmarkUrl?: string | null
  renderYear?: number | null
  compliance?: SiteComplianceConfigPublic | null
  renderLocale: SupportedLocale
  page: PublicAotPageAssembly
}>

export function renderPublicAotPage(assembly: PublicAotPageAssembly): VNode {
  return h(assembly.component, assembly.props, assembly.slots ?? {})
}

export function renderPublicAotShell(assembly: PublicAotShellAssembly): VNode {
  return h(PublicBlogLayoutShell, {
    ...createPublicShellViewState({
      hydrationKind: assembly.kind,
      siteTitle: assembly.siteTitle,
      siteDescription: assembly.siteDescription ?? null,
      siteLogoUrl: assembly.siteLogoUrl ?? null,
      siteLogoDarkUrl: assembly.siteLogoDarkUrl ?? null,
      siteWordmarkUrl: assembly.siteWordmarkUrl ?? null,
      renderYear: assembly.renderYear ?? null,
      compliance: assembly.compliance ?? null,
      spaSearch: false
    }),
    initialLocale: assembly.renderLocale
  }, {
    default: () => renderPublicAotPage(assembly.page)
  })
}
