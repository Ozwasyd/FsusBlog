import { describe, expect, it } from 'vitest'
import { resolveMotionScrollBehavior } from '@/composables/useMotionPreference'

describe('useMotionPreference', () => {
  it('disables smooth scroll when reduced motion is preferred', () => {
    expect(resolveMotionScrollBehavior(true)).toBe('auto')
  })

  it('keeps preferred scroll behavior when motion is allowed', () => {
    expect(resolveMotionScrollBehavior(false)).toBe('smooth')
    expect(resolveMotionScrollBehavior(false, 'auto')).toBe('auto')
  })
})
