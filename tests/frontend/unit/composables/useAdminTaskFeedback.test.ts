import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'

describe('useAdminTaskFeedback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tracks pending, success highlight, and auto-settle', () => {
    const scope = effectScope()
    const feedback = scope.run(() => useAdminTaskFeedback({ settleMs: 500 }))
    expect(feedback).toBeDefined()

    feedback!.begin('正在保存', '文章', 'article-submit')
    expect(feedback!.phase.value).toBe('pending')
    expect(feedback!.busy.value).toBe(true)
    expect(feedback!.ariaMessage.value).toBe('正在保存：文章')

    feedback!.succeed('保存完成', '文章', 'article-submit')
    expect(feedback!.phase.value).toBe('success')
    expect(feedback!.isHighlighted('article-submit')).toBe(true)

    vi.advanceTimersByTime(500)
    expect(feedback!.phase.value).toBe('idle')
    expect(feedback!.highlightedKeys.value).toEqual([])

    scope.stop()
  })

  it('publishes assertive text for failures', () => {
    const scope = effectScope()
    const feedback = scope.run(() => useAdminTaskFeedback({ settleMs: 0 }))

    feedback!.fail('保存失败', new Error('network down'), '保存失败', 'settings-site')

    expect(feedback!.phase.value).toBe('error')
    expect(feedback!.assertiveMessage.value).toBe('保存失败：network down')
    expect(feedback!.isHighlighted('settings-site')).toBe(true)

    scope.stop()
  })
})
