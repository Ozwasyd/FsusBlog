import type { PublicHydrationPageKind } from './types'
import { definePublicAotPage, type PublicAotPageDefinition } from './scaffold'

const pageDefinitions = [
  definePublicAotPage({
    kind: 'Home',
    loadComponent: async () => (await import('./PublicHomePage.vue')).default
  }),
  definePublicAotPage({
    kind: 'ArticleDetail',
    loadComponent: async () => (await import('./PublicArticleDetailPage.vue')).default
  }),
  definePublicAotPage({
    kind: 'About',
    loadComponent: async () => (await import('./PublicAboutPage.vue')).default
  }),
  definePublicAotPage({
    kind: 'Archive',
    loadComponent: async () => (await import('./PublicArchivePage.vue')).default
  }),
  definePublicAotPage({
    kind: 'Filter',
    loadComponent: async () => (await import('./PublicFilterPage.vue')).default
  })
] as const satisfies readonly PublicAotPageDefinition[]

const pageDefinitionMap = Object.fromEntries(
  pageDefinitions.map((definition) => [definition.kind, definition])
) as Record<PublicHydrationPageKind, PublicAotPageDefinition>

export function getPublicAotPageDefinition(kind: PublicHydrationPageKind): PublicAotPageDefinition {
  return pageDefinitionMap[kind]
}

export async function loadPublicAotPageComponent(kind: PublicHydrationPageKind) {
  return await getPublicAotPageDefinition(kind).loadComponent()
}

