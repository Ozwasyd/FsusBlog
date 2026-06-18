import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('public route readiness composable contracts', () => {
  it('lets every public SPA route mark first meaningful content ready independently', () => {
    for (const file of [
      'src/frontend/src/composables/useHomeView.ts',
      'src/frontend/src/composables/useArchiveView.ts',
      'src/frontend/src/composables/useArticleDetailView.ts',
      'src/frontend/src/composables/useFilterView.ts',
      'src/frontend/src/composables/useStaticPage.ts'
    ]) {
      const source = readRepoFile(file)

      expect(source).toContain("from '@/bootstrap/routeReadiness'")
      expect(source).toContain('markCurrentRouteContentReady')
    }
  })

  it('reports route readiness failure from public routes that have explicit error states', () => {
    for (const file of [
      'src/frontend/src/composables/useHomeView.ts',
      'src/frontend/src/composables/useArticleDetailView.ts',
      'src/frontend/src/composables/useFilterView.ts',
      'src/frontend/src/composables/useStaticPage.ts'
    ]) {
      const source = readRepoFile(file)

      expect(source).toContain('markCurrentRouteFailed')
    }
  })
})
