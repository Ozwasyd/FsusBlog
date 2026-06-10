import { h, type Component, type VNode, type VNodeChild } from 'vue'
import { ElConfigProvider } from '@ozwasyd/element-plus'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import { FSUSBLOG_RENDER_PIPELINE_CONFIG } from '@/fsusui/renderPipeline'
import type { SiteComplianceConfigPublic } from '@/api/system'
import type { PublicPageKind } from '@/public-renderers/publicRenderBase'
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState'

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
  compliance?: SiteComplianceConfigPublic | null
  page: PublicAotPageAssembly
}>

export function renderPublicAotPage(assembly: PublicAotPageAssembly): VNode {
  return h(assembly.component, assembly.props, assembly.slots ?? {})
}

export function renderPublicAotShell(assembly: PublicAotShellAssembly): VNode {
  return h(ElConfigProvider, {
    themeMode: 'system',
    renderPipeline: FSUSBLOG_RENDER_PIPELINE_CONFIG
  }, {
    default: () => h(PublicBlogLayoutShell, createPublicShellViewState({
      hydrationKind: assembly.kind,
      siteTitle: assembly.siteTitle,
      compliance: assembly.compliance ?? null,
      spaSearch: false,
      showRuntime: false
    }), {
      default: () => renderPublicAotPage(assembly.page)
    })
  })
}
