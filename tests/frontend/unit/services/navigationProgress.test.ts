import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hideNavigationProgress,
  showNavigationProgress
} from '@/services/navigationProgress'

describe('navigationProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.getElementById('nprogress')?.remove()
  })

  afterEach(() => {
    document.getElementById('nprogress')?.remove()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('builds the progress bar without HTML or style attribute sinks', () => {
    showNavigationProgress()

    const root = document.getElementById('nprogress')
    expect(root).not.toBeNull()
    expect(root?.querySelector('.bar > .peg')).not.toBeNull()
    expect(root?.hasAttribute('style')).toBe(false)
    expect(root?.querySelector('[style]')).toBeNull()
  })

  it('reuses the active bar and removes it after completion', () => {
    showNavigationProgress()
    const root = document.getElementById('nprogress')
    showNavigationProgress()
    expect(document.querySelectorAll('#nprogress')).toHaveLength(1)

    hideNavigationProgress()
    expect(root?.classList.contains('is-completing')).toBe(true)
    vi.runAllTimers()
    expect(document.getElementById('nprogress')).toBeNull()
  })
})
