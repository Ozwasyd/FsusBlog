import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  partial: vi.fn(),
  error: vi.fn()
}))

vi.mock('@/fsusui/feedback', () => ({
  toast: toastMock
}))

describe('useAdminTaskFeedback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
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
    expect(toastMock.info).toHaveBeenCalledWith({
      message: '正在保存',
      detail: '文章',
      duration: 2600
    })

    feedback!.succeed('保存完成', '文章', 'article-submit')
    expect(feedback!.phase.value).toBe('success')
    expect(feedback!.isHighlighted('article-submit')).toBe(true)
    expect(toastMock.success).toHaveBeenCalledWith({
      message: '保存完成',
      detail: '文章',
      duration: 2600
    })

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
    expect(toastMock.error).toHaveBeenCalledWith({
      message: '保存失败',
      detail: 'network down',
      duration: 4000
    })

    scope.stop()
  })

  it('routes partial task feedback through warning toast', () => {
    const scope = effectScope()
    const feedback = scope.run(() => useAdminTaskFeedback({ settleMs: 0 }))

    feedback!.partial('部分完成', '仍需刷新', 'content-import')

    expect(feedback!.phase.value).toBe('partial')
    expect(feedback!.isHighlighted('content-import')).toBe(true)
    expect(toastMock.partial).toHaveBeenCalledWith({
      message: '部分完成',
      detail: '仍需刷新',
      duration: 2600
    })

    scope.stop()
  })
})
