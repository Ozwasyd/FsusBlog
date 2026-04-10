import type { Component } from 'vue'
import type { PublicHydrationPageKind } from './types'

export type PublicAotPageDefinition<K extends PublicHydrationPageKind = PublicHydrationPageKind> = Readonly<{
  kind: K
  loadComponent: () => Promise<Component>
}>

export function definePublicAotPage<K extends PublicHydrationPageKind>(
  definition: PublicAotPageDefinition<K>
): PublicAotPageDefinition<K> {
  return definition
}
