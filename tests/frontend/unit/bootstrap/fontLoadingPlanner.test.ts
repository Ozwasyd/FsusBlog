import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUNDLED_FONT_LOADING_PLAN,
  FONT_LOADING_EVIDENCE_SCHEMA,
  FONT_LOADING_PLAN_SCHEMA,
  FONT_PRELOAD_BUDGET,
  loadBundledFonts,
  recordCriticalFontPlan,
  resetBundledFontLoadingStateForTests,
  selectBundledDeferredFonts,
  validateFontPreloadBudget,
  type BundledFontLoadingPlan
} from '@/bootstrap/fontLoadingPlanner'

describe('fontLoadingPlanner', () => {
  beforeEach(() => {
    resetBundledFontLoadingStateForTests()
  })

  it('represents the existing critical and deferred bootstrap without remote font URLs', () => {
    expect(BUNDLED_FONT_LOADING_PLAN.schema).toBe(FONT_LOADING_PLAN_SCHEMA)
    expect(BUNDLED_FONT_LOADING_PLAN.critical).toEqual([
      'google-sans:400',
      'google-sans:500',
      'google-sans:700',
      'noto-sans-sc:400',
      'noto-sans-sc:500'
    ])
    expect(BUNDLED_FONT_LOADING_PLAN.deferred).toEqual([
      'noto-sans-sc:700',
      'noto-sans-tc:400',
      'noto-sans-tc:500',
      'noto-sans-tc:700',
      'noto-sans-jp:400',
      'noto-sans-jp:500',
      'noto-sans-jp:700',
      'jetbrains-mono:400',
      'jetbrains-mono:500',
      'jetbrains-mono:700'
    ])
    expect(BUNDLED_FONT_LOADING_PLAN.preload).toHaveLength(FONT_PRELOAD_BUDGET)
    expect(JSON.stringify(BUNDLED_FONT_LOADING_PLAN)).not.toMatch(/https?:\/\//u)
    expect(() => validateFontPreloadBudget(BUNDLED_FONT_LOADING_PLAN)).not.toThrow()
  })

  it('selects deterministic route, locale and content-triggered subsets', () => {
    expect(selectBundledDeferredFonts({ trigger: 'route', pathname: '/article/42' })).toEqual([
      'noto-sans-sc:700'
    ])
    expect(selectBundledDeferredFonts({ trigger: 'route', pathname: '/user/manage/articles' })).toEqual([
      'jetbrains-mono:400',
      'jetbrains-mono:500',
      'jetbrains-mono:700'
    ])
    expect(selectBundledDeferredFonts({ trigger: 'locale', locale: 'zh-HK' })).toEqual([
      'noto-sans-tc:400',
      'noto-sans-tc:500',
      'noto-sans-tc:700'
    ])
    expect(selectBundledDeferredFonts({ trigger: 'locale', locale: 'ja-JP' })).toEqual([
      'noto-sans-jp:400',
      'noto-sans-jp:500',
      'noto-sans-jp:700'
    ])
    expect(selectBundledDeferredFonts({ trigger: 'content', hasCode: false, hasEmoji: true })).toEqual([])
  })

  it('deduplicates already-loaded faces and emits machine-readable evidence', async () => {
    const loadStyle = vi.fn(async () => undefined)
    const first = await loadBundledFonts(
      { trigger: 'content', hasCode: true },
      BUNDLED_FONT_LOADING_PLAN,
      loadStyle
    )
    const second = await loadBundledFonts(
      { trigger: 'route', pathname: '/admin' },
      BUNDLED_FONT_LOADING_PLAN,
      loadStyle
    )

    expect(first.schema).toBe(FONT_LOADING_EVIDENCE_SCHEMA)
    expect(first.status).toBe('ok')
    expect(first.loaded).toEqual(BUNDLED_FONT_LOADING_PLAN.route.admin)
    expect(second.loaded).toEqual([])
    expect(second.deduplicated).toEqual(BUNDLED_FONT_LOADING_PLAN.route.admin)
    expect(loadStyle).toHaveBeenCalledTimes(3)
    expect(second.fallbackPreserved).toBe(true)
  })

  it('keeps fallback stacks when a deferred style fails and allows retry', async () => {
    const failed = await loadBundledFonts(
      { trigger: 'locale', locale: 'ja-JP' },
      BUNDLED_FONT_LOADING_PLAN,
      async () => {
        throw new Error('fixture-load-failure')
      }
    )
    const recovered = await loadBundledFonts(
      { trigger: 'locale', locale: 'ja-JP' },
      BUNDLED_FONT_LOADING_PLAN,
      async () => undefined
    )

    expect(failed.status).toBe('fallback')
    expect(failed.failed).toEqual(BUNDLED_FONT_LOADING_PLAN.locale['ja-JP'])
    expect(failed.fallbackPreserved).toBe(true)
    expect(recovered.status).toBe('ok')
    expect(recovered.loaded).toEqual(BUNDLED_FONT_LOADING_PLAN.locale['ja-JP'])
  })

  it('fails closed when preload budget or membership drifts', () => {
    const excessive: BundledFontLoadingPlan = {
      ...BUNDLED_FONT_LOADING_PLAN,
      preload: [
        ...BUNDLED_FONT_LOADING_PLAN.preload,
        'google-sans:700'
      ]
    }
    const deferredPreload: BundledFontLoadingPlan = {
      ...BUNDLED_FONT_LOADING_PLAN,
      preload: ['jetbrains-mono:400']
    }

    expect(() => validateFontPreloadBudget(excessive)).toThrow('font_preload_budget_exceeded')
    expect(() => validateFontPreloadBudget(deferredPreload)).toThrow('font_preload_not_critical')
  })

  it('records critical loading as a deterministic receipt', () => {
    const evidence = recordCriticalFontPlan()
    const repeated = recordCriticalFontPlan()

    expect(evidence.status).toBe('ok')
    expect(evidence.requested).toEqual(BUNDLED_FONT_LOADING_PLAN.critical)
    expect(evidence.loaded).toEqual(BUNDLED_FONT_LOADING_PLAN.critical)
    expect(repeated.requested).toEqual(evidence.requested)
    expect(repeated.preloadCount).toBe(FONT_PRELOAD_BUDGET)
  })
})
