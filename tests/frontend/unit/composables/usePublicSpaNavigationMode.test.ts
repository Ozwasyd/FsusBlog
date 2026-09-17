import { afterEach, describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'

async function loadSpaNavigationModeWithSeed(payload: unknown) {
  vi.resetModules()
  const publicActivationState = shallowRef<{ phase: string }>({
    phase: 'static-visible'
  })
  vi.doMock('@/bootstrap/publicHydrationBootstrap', () => ({
    readPublicHydrationPayload: vi.fn(() => payload)
  }))
  vi.doMock('@/bootstrap/publicActivationRuntime', () => ({
    publicActivationState
  }))

  const { usePublicSpaNavigationMode } = await import('@/composables/usePublicSpaNavigationMode')

  return { usePublicSpaNavigationMode, publicActivationState }
}

describe('usePublicSpaNavigationMode', () => {
  afterEach(() => {
    vi.doUnmock('@/bootstrap/publicHydrationBootstrap')
    vi.resetModules()
  })

  it('keeps takeover first render on SSR-compatible navigation semantics until hydration completes', async () => {
    const { usePublicSpaNavigationMode, publicActivationState } = await loadSpaNavigationModeWithSeed({
      pageKind: 'Home',
      routeKey: 'home',
      rendererVersion: 'test'
    })
    const spaNavigation = usePublicSpaNavigationMode

    expect(spaNavigation.value).toBe(false)

    publicActivationState.value = { phase: 'committing' }
    expect(spaNavigation.value).toBe(false)

    publicActivationState.value = { phase: 'interactive' }
    expect(spaNavigation.value).toBe(true)
  })

  it('keeps direct SPA public renders navigable when no AOT hydration seed exists', async () => {
    const { usePublicSpaNavigationMode } = await loadSpaNavigationModeWithSeed(null)

    expect(usePublicSpaNavigationMode.value).toBe(true)
  })
})
