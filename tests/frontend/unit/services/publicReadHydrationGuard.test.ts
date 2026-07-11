import { describe, expect, it, beforeEach } from 'vitest'
import { isPublicReadHydrationSuppressed } from '@/services/publicReadHydrationGuard'

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

})
