// @vitest-environment happy-dom

import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const progressState = vi.hoisted(() => ({
  progress: undefined as { value: number } | undefined
}))

vi.mock('@/composables/article/useArticleReadingProgress', async () => {
  const { ref } = await import('vue')
  const progress = ref(0.375)
  progressState.progress = progress
  return {
    useArticleReadingProgress: () => ({
      progress,
      refresh: vi.fn()
    })
  }
})

import ArticleReadingProgress from '@/components/article/ArticleReadingProgress.vue'

afterEach(() => {
  document.head.querySelectorAll('[data-fsus-csp-runtime-style]').forEach((node) => node.remove())
  document.body.replaceChildren()
  if (progressState.progress) {
    progressState.progress.value = 0.375
  }
})

describe('ArticleReadingProgress', () => {
  it('keeps progress decorative while publishing a bounded CSS scale value', async () => {
    const wrapper = mount(ArticleReadingProgress, {
      props: { contentRoot: null },
      attachTo: document.body
    })

    expect(wrapper.attributes('aria-hidden')).toBe('true')
    expect(wrapper.attributes('data-reading-progress')).toBe('true')
    expect(wrapper.findAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(0)

    const runtimeStyle = document.head.querySelector<HTMLStyleElement>(
      '[data-fsus-csp-runtime-style="vue-directive"]'
    )
    expect(runtimeStyle?.sheet?.cssRules[0]?.cssText).toContain('--article-reading-progress: 0.3750')

    expect(progressState.progress).toBeDefined()
    progressState.progress!.value = 0
    await wrapper.vm.$nextTick()
    expect(runtimeStyle?.sheet?.cssRules[0]?.cssText).toContain('--article-reading-progress: 0.0000')

    wrapper.unmount()
  })
})
