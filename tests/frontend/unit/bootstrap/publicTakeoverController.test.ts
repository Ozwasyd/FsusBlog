import { beforeEach, describe, expect, it, vi } from 'vitest'

const snapshotReveal = vi.fn(async () => {})
const createPublicTakeoverSnapshot = vi.fn(() => ({
  element: document.createElement('div'),
  reveal: snapshotReveal,
  remove: vi.fn()
}))
const beginRouteReadiness = vi.fn()
const waitForRouteContentReady = vi.fn<typeof import('@/bootstrap/routeReadiness').waitForRouteContentReady>(async () => 'ready')

vi.mock('@/bootstrap/publicTakeoverSnapshot', () => ({ createPublicTakeoverSnapshot }))
vi.mock('@/bootstrap/routeReadiness', () => ({
  beginRouteReadiness,
  waitForRouteContentReady
}))

describe('public takeover controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    waitForRouteContentReady.mockResolvedValue('ready')
  })

  it('starts a visual guard by cloning the snapshot and opening the readiness barrier', async () => {
    const { beginPublicTakeoverVisualGuard } = await import('@/bootstrap/publicTakeoverController')

    const guard = beginPublicTakeoverVisualGuard({
      navigationId: '/archive',
      timeoutMs: 250
    })

    expect(createPublicTakeoverSnapshot).toHaveBeenCalledTimes(1)
    expect(beginRouteReadiness).toHaveBeenCalledWith('/archive')
    expect(guard.navigationId).toBe('/archive')
    expect(guard.timeoutMs).toBe(250)
  })

  it('reveals the snapshot only after route content becomes ready', async () => {
    const {
      beginPublicTakeoverVisualGuard,
      waitForPublicTakeoverVisualReady
    } = await import('@/bootstrap/publicTakeoverController')

    const guard = beginPublicTakeoverVisualGuard({
      navigationId: '/archive',
      timeoutMs: 250
    })
    await waitForPublicTakeoverVisualReady(guard)

    expect(waitForRouteContentReady).toHaveBeenCalledWith('/archive', 250)
    expect(snapshotReveal).toHaveBeenCalledTimes(1)
  })

  it('keeps the snapshot in place and throws when readiness times out', async () => {
    const {
      PublicTakeoverRouteReadinessError,
      beginPublicTakeoverVisualGuard,
      waitForPublicTakeoverVisualReady
    } = await import('@/bootstrap/publicTakeoverController')
    waitForRouteContentReady.mockResolvedValueOnce('timeout')

    const guard = beginPublicTakeoverVisualGuard({
      navigationId: '/archive',
      timeoutMs: 250
    })

    await expect(waitForPublicTakeoverVisualReady(guard)).rejects.toBeInstanceOf(PublicTakeoverRouteReadinessError)
    expect(snapshotReveal).not.toHaveBeenCalled()
  })
})
