import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isPublicReadHydrationSuppressed } from '@/services/publicReadHydrationGuard'

const repoRoot = resolve(__dirname, '../../../..')

describe('public read hydration guard', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, '__FSUSBLOG_DISABLE_HUMAN_READ_PROOF__')
    Reflect.deleteProperty(window, '__FSUSBLOG_DISABLE_PUBLIC_READ_HYDRATION__')
    delete document.documentElement.dataset.fsusDisableHumanReadProof
    delete document.documentElement.dataset.fsusDisablePublicReadHydration
  })

  it('suppresses optional public read hydration when acceptance disables human read proof', () => {
    Object.defineProperty(window, '__FSUSBLOG_DISABLE_HUMAN_READ_PROOF__', {
      value: true,
      configurable: true
    })

    expect(isPublicReadHydrationSuppressed()).toBe(true)
  })

  it('suppresses optional public read hydration from the explicit runtime flag and dataset', () => {
    Object.defineProperty(window, '__FSUSBLOG_DISABLE_PUBLIC_READ_HYDRATION__', {
      value: true,
      configurable: true
    })

    expect(isPublicReadHydrationSuppressed()).toBe(true)

    Reflect.deleteProperty(window, '__FSUSBLOG_DISABLE_PUBLIC_READ_HYDRATION__')
    document.documentElement.dataset.fsusDisablePublicReadHydration = 'true'

    expect(isPublicReadHydrationSuppressed()).toBe(true)
  })

  it('keeps article detail related and comment auto-load behind the public read hydration guard', () => {
    const source = readFileSync(resolve(repoRoot, 'src/frontend/src/composables/useArticleDetailView.ts'), 'utf8')

    expect(source).toContain("import { isPublicReadHydrationSuppressed } from '@/services/publicReadHydrationGuard'")
    expect(source).toContain('if (isPublicReadHydrationSuppressed())')
    expect(source.indexOf('if (isPublicReadHydrationSuppressed())')).toBeLessThan(source.indexOf('await getRelatedReading(articleId'))
    expect(source.indexOf('await hydrateCommentStream()')).toBeGreaterThan(source.indexOf('const hydrateCommentStream = async'))
    expect(source).toContain('if (isPublicReadHydrationSuppressed()) {\n      clearCommentState()\n      return\n    }')
  })
})
