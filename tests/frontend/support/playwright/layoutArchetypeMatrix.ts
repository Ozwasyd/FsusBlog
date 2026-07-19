import matrix from '../../fixtures/layout-archetype-matrix.json' with { type: 'json' }

export type LayoutArchetypeSurface = 'public' | 'identity' | 'admin'

export type LayoutArchetype = Readonly<{
  surface: LayoutArchetypeSurface
  kind: string
  path: string
  label: string
  primary: string
  screenshotTarget: string
  snapshot: boolean
  critical: boolean
}>

export const LAYOUT_ARCHETYPE_MATRIX = matrix as Readonly<{
  version: string
  sourceIssue: number
  coverage: Readonly<{
    viewports: readonly string[]
    themes: readonly string[]
    media: readonly string[]
    contracts: readonly string[]
  }>
  archetypes: readonly LayoutArchetype[]
}>

export const PUBLIC_LAYOUT_ARCHETYPES = LAYOUT_ARCHETYPE_MATRIX.archetypes
  .filter((archetype) => archetype.surface === 'public')

export const IDENTITY_LAYOUT_ARCHETYPES = LAYOUT_ARCHETYPE_MATRIX.archetypes
  .filter((archetype) => archetype.surface === 'identity')

export const ADMIN_LAYOUT_ARCHETYPES = LAYOUT_ARCHETYPE_MATRIX.archetypes
  .filter((archetype) => archetype.surface === 'admin')

export function resolveLayoutArchetypePath(
  archetype: LayoutArchetype,
  fixtures: Readonly<{ articleId?: string; searchKeyword?: string }> = {}
): string {
  return archetype.path
    .replace('{articleId}', encodeURIComponent(fixtures.articleId ?? '1'))
    .replace('{searchKeyword}', encodeURIComponent(fixtures.searchKeyword ?? 'test'))
}
