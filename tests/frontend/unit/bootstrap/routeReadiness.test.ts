import { afterEach, describe, expect, it, vi } from 'vitest'

describe('route readiness barrier', () => {
  afterEach(async () => {
    vi.useRealTimers()
    const { resetRouteReadinessForTests } = await import('@/bootstrap/routeReadiness')
    resetRouteReadinessForTests()
  })

  it('resolves ready when route content marks the active navigation ready', async () => {
    const {
      beginRouteReadiness,
      markRouteContentReady,
      waitForRouteContentReady
    } = await import('@/bootstrap/routeReadiness')

    beginRouteReadiness('/archive')
    const result = waitForRouteContentReady('/archive', 1000)
    markRouteContentReady('/archive')

    await expect(result).resolves.toBe('ready')
  })

  it('resolves failed when the route reports that first meaningful content failed', async () => {
    const {
      beginRouteReadiness,
      markRouteFailed,
      waitForRouteContentReady
    } = await import('@/bootstrap/routeReadiness')

    beginRouteReadiness('/article/1')
    const result = waitForRouteContentReady('/article/1', 1000)
    markRouteFailed('/article/1')

    await expect(result).resolves.toBe('failed')
  })

  it('resolves timeout when no route content readiness signal arrives', async () => {
    vi.useFakeTimers()
    const {
      beginRouteReadiness,
      waitForRouteContentReady
    } = await import('@/bootstrap/routeReadiness')

    beginRouteReadiness('/about')
    const result = waitForRouteContentReady('/about', 50)
    await vi.advanceTimersByTimeAsync(50)

    await expect(result).resolves.toBe('timeout')
  })

  it('can mark readiness from a route-like object fullPath', async () => {
    const {
      beginRouteReadiness,
      markCurrentRouteContentReady,
      waitForRouteContentReady
    } = await import('@/bootstrap/routeReadiness')

    beginRouteReadiness('/search?q=test')
    const result = waitForRouteContentReady('/search?q=test', 1000)
    markCurrentRouteContentReady({ fullPath: '/search?q=test' })

    await expect(result).resolves.toBe('ready')
  })
})
