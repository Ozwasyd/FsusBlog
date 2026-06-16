import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadSpaNavigationModeWithSeed(payload: unknown) {
  vi.resetModules()
  vi.doMock('@/bootstrap/publicHydrationBootstrap', () => ({
    readPublicHydrationPayload: vi.fn(() => payload)
  }))

  const [{ usePublicSpaNavigationMode }, takeoverState] = await Promise.all([
    import('@/composables/usePublicSpaNavigationMode'),
    import('@/bootstrap/publicTakeoverState')
  ])

  return { usePublicSpaNavigationMode, takeoverState }
}

describe('usePublicSpaNavigationMode', () => {
  afterEach(() => {
    vi.doUnmock('@/bootstrap/publicHydrationBootstrap')
    vi.resetModules()
  })

  it('keeps takeover first render on SSR-compatible navigation semantics until hydration completes', async () => {
    const { usePublicSpaNavigationMode, takeoverState } = await loadSpaNavigationModeWithSeed({
      pageKind: 'Home',
      routeKey: 'home',
      rendererVersion: 'test'
    })
    const spaNavigation = usePublicSpaNavigationMode()

    expect(spaNavigation.value).toBe(false)

    takeoverState.beginPublicTakeoverHydration()
    expect(spaNavigation.value).toBe(false)

    takeoverState.completePublicTakeoverHydration()
    expect(spaNavigation.value).toBe(true)
  })

  it('keeps direct SPA public renders navigable when no AOT hydration seed exists', async () => {
    const { usePublicSpaNavigationMode } = await loadSpaNavigationModeWithSeed(null)

    expect(usePublicSpaNavigationMode().value).toBe(true)
  })
})
