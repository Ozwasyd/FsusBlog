import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRowStateMotion } from '@/composables/useRowStateMotion'

describe('useRowStateMotion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tracks pending rows and auto-clears updated rows', () => {
    const scope = effectScope()
    const motion = scope.run(() => useRowStateMotion({ settleMs: 400 }))
    expect(motion).toBeDefined()

    motion!.markPending('row-1', '正在处理')
    expect(motion!.stateFor('row-1')).toBe('pending')
    expect(motion!.classFor('row-1')).toContain('blog-motion-row-pending')
    expect(motion!.summary.value).toBe('正在处理')

    motion!.markUpdated('row-1', '处理完成')
    expect(motion!.stateFor('row-1')).toBe('updated')
    expect(motion!.classFor('row-1')).toContain('blog-motion-row-updated')

    vi.advanceTimersByTime(400)
    expect(motion!.stateFor('row-1')).toBeNull()
    expect(motion!.hasActiveRows.value).toBe(false)

    scope.stop()
  })

  it('uses summary feedback instead of marking more than the visible limit', () => {
    const motion = useRowStateMotion({ visibleLimit: 2 })

    motion.markUpdated(['a', 'b', 'c'], '批量更新完成')

    expect(motion.summary.value).toBe('批量更新完成')
    expect(motion.states.value).toEqual({})
  })
})
